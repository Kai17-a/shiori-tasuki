use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::activity::{EventKind, record};
use crate::task::{GithubLink, NewSubtask, NewTask, Status, SubtaskSummary, Task, TaskUpdate};

/// Longest accepted title, in characters; keeps the board and GitHub titles readable.
pub const MAX_TITLE_CHARS: usize = 200;

/// Schema version stored in `PRAGMA user_version`.
const SCHEMA_VERSION: i64 = 6;

/// Current-format SQL timestamp.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/// Migrations indexed by the version they upgrade from; version 0 is an empty file.
const MIGRATIONS: [&str; 6] = [
    SCHEMA_V1,
    MIGRATE_V1_TO_V2,
    MIGRATE_V2_TO_V3,
    MIGRATE_V3_TO_V4,
    MIGRATE_V4_TO_V5,
    MIGRATE_V5_TO_V6,
];

const MIGRATE_V5_TO_V6: &str = "
ALTER TABLE task_events RENAME TO legacy_task_events;
CREATE TABLE task_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 actor TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', from_status TEXT, to_status TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));
INSERT INTO task_events SELECT * FROM legacy_task_events;
CREATE INDEX events_by_task ON task_events(task_id, id);
CREATE TABLE work_sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 agent TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
 ended_at TEXT, outcome TEXT NOT NULL DEFAULT 'running', thread_id TEXT, workdir TEXT,
 start_git TEXT, end_git TEXT, summary TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]');
CREATE INDEX sessions_by_task ON work_sessions(task_id, id);
";

const SCHEMA_V1: &str = "
CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
    created_by  TEXT NOT NULL DEFAULT 'user',
    gh_repo     TEXT,
    gh_number   INTEGER,
    gh_url      TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (gh_repo, gh_number)
);
CREATE INDEX tasks_parent ON tasks(parent_id);
";

const MIGRATE_V1_TO_V2: &str = "
ALTER TABLE tasks ADD COLUMN completed_at TEXT;
UPDATE tasks SET completed_at = updated_at WHERE status = 'done';
";

const MIGRATE_V2_TO_V3: &str = "
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE images (
    name         TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
";

/// Adds who is working on a task and the history of what happened to it.
/// Existing tasks get their creation as the first history entry.
const MIGRATE_V3_TO_V4: &str = "
ALTER TABLE tasks ADD COLUMN assignee TEXT;
CREATE TABLE task_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor       TEXT NOT NULL,
    kind        TEXT NOT NULL
                CHECK (kind IN ('created', 'status', 'updated', 'assigned', 'note', 'split')),
    message     TEXT NOT NULL DEFAULT '',
    from_status TEXT,
    to_status   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX task_events_task ON task_events(task_id, id);
INSERT INTO task_events (task_id, actor, kind, created_at)
    SELECT id, created_by, 'created', created_at FROM tasks ORDER BY id;
";

/// Preserves task execution metadata: where a task is worked on, how often it was
/// tried, the issue state last seen on GitHub, and one row per agent run.
const MIGRATE_V4_TO_V5: &str = "
ALTER TABLE tasks ADD COLUMN workdir TEXT;
ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN gh_state TEXT;
UPDATE tasks SET gh_state = CASE WHEN status = 'done' THEN 'closed' ELSE 'open' END
    WHERE gh_repo IS NOT NULL;
CREATE TABLE task_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent       TEXT NOT NULL,
    workdir     TEXT NOT NULL,
    outcome     TEXT NOT NULL DEFAULT 'running'
                CHECK (outcome IN ('running', 'completed', 'split', 'failed', 'timed_out')),
    exit_code   INTEGER,
    output      TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT
);
CREATE INDEX task_runs_task ON task_runs(task_id, id);
CREATE INDEX task_runs_outcome ON task_runs(outcome);
";

/// Columns read by [`task_from_row`], with the subtask counts computed per row.
pub(crate) const SELECT: &str = "
SELECT t.id, t.parent_id, t.title, t.description, t.status, t.created_by,
       t.gh_repo, t.gh_number, t.gh_url, t.created_at, t.updated_at, t.completed_at,
       (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS subtask_total,
       (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.status = 'done') AS subtask_done,
       t.assignee,
       COALESCE((SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = t.id), t.updated_at)
           AS last_activity_at,
       t.workdir, t.attempts
FROM tasks t";

/// One GitHub issue as written by [`Store::upsert_github_issue`].
#[derive(Debug)]
pub(crate) struct IssueRecord<'a> {
    pub link: GithubLink,
    /// Already shortened to [`MAX_TITLE_CHARS`].
    pub title: String,
    pub body: &'a str,
    pub closed: bool,
    pub created_at: Option<&'a str>,
    pub closed_at: Option<&'a str>,
}

/// What [`Store::upsert_github_issue`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Upsert {
    Created,
    Updated,
    Unchanged,
}

/// Which tasks [`Store::list`] returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    TopLevel,
    ChildrenOf(i64),
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(
        "GitHub から取り込んだタスクの題名と説明は変更できません。GitHub 側で編集してください。"
    )]
    ExternalContent,
    #[error("task {0} not found")]
    NotFound(i64),
    #[error("{0}")]
    Invalid(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("cannot prepare database location: {0}")]
    Io(#[from] std::io::Error),
}

/// SQLite-backed task storage, cheap to clone and share between threads.
#[derive(Debug, Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    /// Opens (creating if needed) the database file and its parent directories.
    ///
    /// # Errors
    ///
    /// Fails when the directory cannot be created or the file is not a usable database.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    /// Opens a private database that disappears when the store is dropped.
    ///
    /// # Errors
    ///
    /// Fails only if SQLite cannot allocate the database.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::Invalid(format!(
                "database schema {version} is newer than this program supports ({SCHEMA_VERSION})"
            )));
        }
        for (from, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", from as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("store lock poisoned")
    }

    /// Creates one task, optionally under an existing parent.
    ///
    /// # Errors
    ///
    /// [`StoreError::Invalid`] for a blank or overlong title,
    /// [`StoreError::NotFound`] when the parent does not exist.
    pub fn create(&self, new: NewTask) -> Result<Task, StoreError> {
        if new.status == Some(Status::Done)
            && crate::activity::is_agent(new.created_by.as_deref().unwrap_or("user"))
        {
            return Err(crate::activity::agent_done_error());
        }
        let title = validate_title(&new.title)?;
        let created_by = new.created_by.as_deref().unwrap_or("user");
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some(parent) = new.parent_id {
            ensure_exists(&tx, parent)?;
        }
        tx.execute(
            &format!(
                "INSERT INTO tasks
                    (parent_id, title, description, status, created_by, completed_at, workdir)
                 VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?4 = 'done' THEN {NOW} END,
                    COALESCE(?6, (SELECT workdir FROM tasks WHERE id = ?1)))"
            ),
            params![
                new.parent_id,
                title,
                new.description.trim(),
                new.status.unwrap_or_default().as_str(),
                created_by,
                new.workdir
                    .as_deref()
                    .map(str::trim)
                    .filter(|w| !w.is_empty())
            ],
        )?;
        let id = tx.last_insert_rowid();
        record(&tx, id, created_by, EventKind::Created, "", None)?;
        tx.commit()?;
        fetch(&conn, id)
    }

    /// Adds several child tasks to `parent_id` in one transaction: all or nothing.
    ///
    /// # Errors
    ///
    /// [`StoreError::Invalid`] when the list is empty or any title is invalid,
    /// [`StoreError::NotFound`] when the parent does not exist.
    pub fn create_subtasks(
        &self,
        parent_id: i64,
        subtasks: Vec<NewSubtask>,
        created_by: &str,
    ) -> Result<Vec<Task>, StoreError> {
        if subtasks.is_empty() {
            return Err(StoreError::Invalid(
                "at least one subtask is required".into(),
            ));
        }
        let titles: Vec<&str> = subtasks
            .iter()
            .map(|s| validate_title(&s.title))
            .collect::<Result<_, _>>()?;

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        ensure_exists(&tx, parent_id)?;
        let mut ids = Vec::with_capacity(subtasks.len());
        for (subtask, title) in subtasks.iter().zip(titles) {
            tx.execute(
                "INSERT INTO tasks (parent_id, title, description, created_by, workdir)
                 VALUES (?1, ?2, ?3, ?4, (SELECT workdir FROM tasks WHERE id = ?1))",
                params![parent_id, title, subtask.description.trim(), created_by],
            )?;
            let id = tx.last_insert_rowid();
            record(&tx, id, created_by, EventKind::Created, "", None)?;
            ids.push(id);
        }
        record(
            &tx,
            parent_id,
            created_by,
            EventKind::Split,
            &format!("子タスクを{}件作成", ids.len()),
            None,
        )?;
        tx.commit()?;
        ids.into_iter().map(|id| fetch(&conn, id)).collect()
    }

    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn get(&self, id: i64) -> Result<Option<Task>, StoreError> {
        let conn = self.conn();
        Ok(conn
            .query_row(&format!("{SELECT} WHERE t.id = ?1"), [id], task_from_row)
            .optional()?)
    }

    /// Lists tasks in creation order.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn list(&self, scope: Scope) -> Result<Vec<Task>, StoreError> {
        let conn = self.conn();
        let (filter, parent) = match scope {
            Scope::All => ("", None),
            Scope::TopLevel => (" WHERE t.parent_id IS NULL", None),
            Scope::ChildrenOf(id) => (" WHERE t.parent_id = ?1", Some(id)),
        };
        let mut stmt = conn.prepare(&format!("{SELECT}{filter} ORDER BY t.id"))?;
        let rows = match parent {
            Some(id) => stmt.query_map([id], task_from_row)?,
            None => stmt.query_map([], task_from_row)?,
        };
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Applies the fields set in `update` on behalf of a person (`user`).
    ///
    /// # Errors
    ///
    /// See [`Store::update_as`].
    pub fn update(&self, id: i64, update: TaskUpdate) -> Result<Task, StoreError> {
        self.update_as(id, update, "user")
    }

    /// Applies the fields set in `update` and records what changed, and who changed it,
    /// in the task's history. A change that leaves everything as it was records nothing.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] for an unknown id, [`StoreError::Invalid`] for a bad title.
    pub fn update_as(&self, id: i64, update: TaskUpdate, actor: &str) -> Result<Task, StoreError> {
        if update.status == Some(Status::Done) && crate::activity::is_agent(actor) {
            return Err(crate::activity::agent_done_error());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        apply_update(&tx, id, &update, actor)?;
        if update.status == Some(Status::Done) {
            complete_ancestors(&tx, id, actor)?;
        }
        tx.commit()?;
        fetch(&conn, id)
    }

    /// Deletes a task together with all of its descendants.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] for an unknown id.
    pub fn delete(&self, id: i64) -> Result<(), StoreError> {
        match self
            .conn()
            .execute("DELETE FROM tasks WHERE id = ?1", [id])?
        {
            0 => Err(StoreError::NotFound(id)),
            _ => Ok(()),
        }
    }

    /// Records that a task mirrors the given GitHub issue.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] for an unknown id, [`StoreError::Invalid`] when another
    /// task is already linked to the same issue.
    pub fn link_github(&self, id: i64, link: &GithubLink) -> Result<Task, StoreError> {
        let conn = self.conn();
        let changed = conn
            .execute(
                "UPDATE tasks SET gh_repo = ?2, gh_number = ?3, gh_url = ?4,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                 WHERE id = ?1",
                params![id, link.repo, link.number, link.url],
            )
            .map_err(|e| unique_violation(e, link))?;
        if changed == 0 {
            return Err(StoreError::NotFound(id));
        }
        fetch(&conn, id)
    }

    /// Creates or refreshes the task mirroring one GitHub issue, atomically, so two
    /// processes syncing at once cannot create duplicates.
    ///
    /// Only real changes are written; an unchanged issue keeps its `updated_at`, so the
    /// periodic sync does not flood "recent activity". A closed issue makes the task
    /// done (completed at the issue's close time), a reopened one moves a done task back
    /// to todo, and any other local status is kept.
    pub(crate) fn upsert_github_issue(
        &self,
        issue: &IssueRecord<'_>,
    ) -> Result<Upsert, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<(i64, String, Option<String>)> = tx
            .query_row(
                "SELECT id, status, gh_state FROM tasks WHERE gh_repo = ?1 AND gh_number = ?2",
                params![issue.link.repo, issue.link.number],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let gh_state = if issue.closed { "closed" } else { "open" };
        let outcome = match existing {
            None => {
                let status = if issue.closed {
                    Status::Done
                } else {
                    Status::Todo
                };
                tx.execute(
                    &format!(
                        "INSERT INTO tasks (title, description, status, created_by,
                            gh_repo, gh_number, gh_url, created_at, completed_at, gh_state)
                         VALUES (?1, ?2, ?3, 'github', ?4, ?5, ?6, COALESCE(?7, {NOW}),
                            CASE WHEN ?3 = 'done' THEN COALESCE(?8, {NOW}) END, ?9)"
                    ),
                    params![
                        issue.title,
                        issue.body.trim(),
                        status.as_str(),
                        issue.link.repo,
                        issue.link.number,
                        issue.link.url,
                        issue.created_at,
                        issue.closed_at,
                        gh_state
                    ],
                )?;
                let id = tx.last_insert_rowid();
                tx.execute(
                    &format!(
                        "INSERT INTO task_events (task_id, actor, kind, created_at)
                         VALUES (?1, 'github', 'created', COALESCE(?2, {NOW}))"
                    ),
                    params![id, issue.created_at],
                )?;
                Upsert::Created
            }
            Some((id, current, previous_state)) => {
                // Only a real reopen moves a done task back. A task an agent finished
                // while its issue is still open stays done; otherwise a later sync would
                // pick it up again after every sync.
                let reopened = !issue.closed && previous_state.as_deref() == Some("closed");
                let status = match (issue.closed, current.as_str()) {
                    (true, _) => Status::Done.as_str(),
                    (false, "done") if reopened => Status::Todo.as_str(),
                    (false, other) => other,
                };
                tx.execute(
                    "UPDATE tasks SET gh_state = ?2 WHERE id = ?1",
                    params![id, gh_state],
                )?;
                let changed = tx.execute(
                    &format!(
                        "UPDATE tasks SET
                            title = ?2, description = ?3, gh_url = ?4,
                            completed_at = CASE
                                WHEN ?5 != 'done' THEN NULL
                                WHEN status = 'done' THEN completed_at
                                ELSE COALESCE(?6, {NOW})
                            END,
                            status = ?5,
                            updated_at = {NOW}
                         WHERE id = ?1 AND (title IS NOT ?2 OR description IS NOT ?3
                            OR gh_url IS NOT ?4 OR status IS NOT ?5)"
                    ),
                    params![
                        id,
                        issue.title,
                        issue.body.trim(),
                        issue.link.url,
                        status,
                        issue.closed_at
                    ],
                )?;
                if changed == 0 {
                    Upsert::Unchanged
                } else {
                    let before: Status = current.parse().unwrap_or_default();
                    let after: Status = status.parse().unwrap_or_default();
                    if before == after {
                        record(
                            &tx,
                            id,
                            "github",
                            EventKind::Updated,
                            "GitHubの内容を反映",
                            None,
                        )?;
                    } else {
                        let message = if issue.closed {
                            "GitHubでクローズ"
                        } else {
                            "GitHubで再オープン"
                        };
                        record(
                            &tx,
                            id,
                            "github",
                            EventKind::Status,
                            message,
                            Some((before, after)),
                        )?;
                    }
                    Upsert::Updated
                }
            }
        };
        tx.commit()?;
        Ok(outcome)
    }

    /// Updates only GitHub-owned hierarchy, without local status propagation.
    pub(crate) fn sync_github_parent(
        &self,
        id: i64,
        parent_id: Option<i64>,
    ) -> Result<bool, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let task = fetch(&tx, id)?;
        if task.github.is_none() || task.parent_id == parent_id {
            return Ok(false);
        }
        if let Some(current) = task.parent_id
            && fetch(&tx, current)?.github.is_none()
        {
            return Ok(false);
        }
        let mut parent_ref = None;
        if let Some(parent) = parent_id {
            let Some(link) = fetch(&tx, parent)?.github else {
                return Ok(false);
            };
            parent_ref = Some(format!("{}#{}", link.repo, link.number));
            let cycle: bool = tx.query_row(
                "WITH RECURSIVE ancestors(id, parent_id) AS (
                    SELECT id, parent_id FROM tasks WHERE id = ?1
                    UNION SELECT t.id, t.parent_id FROM tasks t JOIN ancestors a ON t.id = a.parent_id
                 ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ?2)",
                params![parent, id], |r| r.get(0))?;
            if cycle {
                return Ok(false);
            }
        }
        tx.execute(
            &format!("UPDATE tasks SET parent_id = ?2, updated_at = {NOW} WHERE id = ?1"),
            params![id, parent_id],
        )?;
        // Name the parent by its GitHub issue, not the local task id, which reads like one.
        let message = match parent_ref {
            Some(parent) => format!("GitHubの親子関係を反映（親: {parent}）"),
            None => "GitHubの親子関係を解除".to_owned(),
        };
        record(&tx, id, "github", EventKind::Updated, &message, None)?;
        tx.commit()?;
        Ok(true)
    }

    /// Finds the task linked to `repo#number`.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn find_by_github(&self, repo: &str, number: u32) -> Result<Option<Task>, StoreError> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                &format!("{SELECT} WHERE t.gh_repo = ?1 AND t.gh_number = ?2"),
                params![repo, number],
                task_from_row,
            )
            .optional()?)
    }
}

/// Writes `update` and its history entries inside an open transaction.
pub(crate) fn apply_update(
    tx: &Connection,
    id: i64,
    update: &TaskUpdate,
    actor: &str,
) -> Result<(), StoreError> {
    let current = tx
        .query_row(&format!("{SELECT} WHERE t.id = ?1"), [id], task_from_row)
        .optional()?
        .ok_or(StoreError::NotFound(id))?;
    let title = match &update.title {
        Some(t) => validate_title(t)?.to_owned(),
        None => current.title.clone(),
    };
    let description = update
        .description
        .as_deref()
        .map_or_else(|| current.description.clone(), |d| d.trim().to_owned());
    let status = update.status.unwrap_or(current.status);
    let assignee = match &update.assignee {
        Some(a) if a.trim().is_empty() => None,
        Some(a) => Some(a.trim().to_owned()),
        None => current.assignee.clone(),
    };
    let content_changed = title != current.title || description != current.description;
    if content_changed && current.is_external() {
        return Err(StoreError::ExternalContent);
    }
    let status_changed = status != current.status;
    let assignee_changed = assignee != current.assignee;
    if !(content_changed || status_changed || assignee_changed) {
        return Ok(());
    }
    tx.execute(
        &format!(
            "UPDATE tasks SET title = ?2, description = ?3, assignee = ?5,
                completed_at = CASE
                    WHEN ?4 != 'done' THEN NULL
                    ELSE COALESCE(completed_at, {NOW})
                END,
                status = ?4,
                updated_at = {NOW}
             WHERE id = ?1"
        ),
        params![id, title, description, status.as_str(), assignee],
    )?;
    if content_changed {
        record(tx, id, actor, EventKind::Updated, "", None)?;
    }
    if assignee_changed {
        record(
            tx,
            id,
            actor,
            EventKind::Assigned,
            assignee.as_deref().unwrap_or(""),
            None,
        )?;
    }
    if status_changed {
        record(
            tx,
            id,
            actor,
            EventKind::Status,
            "",
            Some((current.status, status)),
        )?;
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<&str, StoreError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(StoreError::Invalid("title must not be empty".into()));
    }
    let len = title.chars().count();
    if len > MAX_TITLE_CHARS {
        return Err(StoreError::Invalid(format!(
            "title is {len} characters; the limit is {MAX_TITLE_CHARS}"
        )));
    }
    Ok(title)
}

fn ensure_exists(conn: &Connection, id: i64) -> Result<(), StoreError> {
    let found = conn
        .query_row("SELECT 1 FROM tasks WHERE id = ?1", [id], |_| Ok(()))
        .optional()?;
    found.ok_or(StoreError::NotFound(id))
}

fn fetch(conn: &Connection, id: i64) -> Result<Task, StoreError> {
    conn.query_row(&format!("{SELECT} WHERE t.id = ?1"), [id], task_from_row)
        .optional()?
        .ok_or(StoreError::NotFound(id))
}

fn unique_violation(err: rusqlite::Error, link: &GithubLink) -> StoreError {
    match err.sqlite_error_code() {
        Some(rusqlite::ErrorCode::ConstraintViolation) => StoreError::Invalid(format!(
            "{}#{} is already linked to another task",
            link.repo, link.number
        )),
        _ => StoreError::Db(err),
    }
}

pub(crate) fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let status: String = row.get(4)?;
    let status = status.parse::<Status>().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let repo: Option<String> = row.get(6)?;
    let number: Option<u32> = row.get(7)?;
    let url: Option<String> = row.get(8)?;
    let github = match (repo, number, url) {
        (Some(repo), Some(number), Some(url)) => Some(GithubLink { repo, number, url }),
        _ => None,
    };
    Ok(Task {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        status,
        created_by: row.get(5)?,
        github,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        completed_at: row.get(11)?,
        assignee: row.get(14)?,
        last_activity_at: row.get(15)?,
        workdir: row.get(16)?,
        attempts: row.get(17)?,
        subtasks: SubtaskSummary {
            total: row.get(12)?,
            done: row.get(13)?,
        },
    })
}

/// Completes only ancestors of the task just marked done, within the same transaction.
pub(crate) fn complete_ancestors(
    conn: &Connection,
    mut id: i64,
    actor: &str,
) -> Result<(), StoreError> {
    loop {
        let parent: Option<i64> =
            conn.query_row("SELECT parent_id FROM tasks WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        let Some(parent) = parent else { break };
        let open: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE parent_id = ?1 AND status != 'done')",
            [parent],
            |row| row.get(0),
        )?;
        if open {
            break;
        }
        apply_update(
            conn,
            parent,
            &TaskUpdate {
                status: Some(Status::Done),
                ..TaskUpdate::default()
            },
            actor,
        )?;
        id = parent;
    }
    Ok(())
}
