//! Task history: who created, moved, edited, assigned or commented on a task, and when.
//!
//! The history is what lets a person see what an AI agent actually did, and what lets an
//! agent read why an earlier run failed.

use std::str::FromStr;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::Actor;
use crate::store::{Store, StoreError, apply_update, complete_ancestors, write_tx};
use crate::task::{Status, Task, TaskUpdate};
use crate::work::SessionOutcome;

/// Longest accepted note, in characters.
const MAX_NOTE_CHARS: usize = 4000;

/// What a history entry records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Created,
    Started,
    Reported,
    Approved,
    Rejected,
    Failed,
    /// Status changed; see the entry's `from_status` and `to_status`.
    Status,
    /// Title or description changed.
    Updated,
    /// Assignee changed; the message holds the new assignee, empty when cleared.
    Assigned,
    /// A progress report, review summary or reviewer comment.
    Note,
    /// Subtasks were added; the message says how many.
    Split,
}

impl EventKind {
    const ALL: [Self; 11] = [
        Self::Created,
        Self::Started,
        Self::Reported,
        Self::Approved,
        Self::Rejected,
        Self::Failed,
        Self::Status,
        Self::Updated,
        Self::Assigned,
        Self::Note,
        Self::Split,
    ];

    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Started => "started",
            Self::Reported => "reported",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
            Self::Status => "status",
            Self::Updated => "updated",
            Self::Assigned => "assigned",
            Self::Note => "note",
            Self::Split => "split",
        }
    }
}

/// Error returned when a string is not one of the known [`EventKind`] values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown history entry kind {0:?}")]
pub struct ParseEventKindError(String);

impl FromStr for EventKind {
    type Err = ParseEventKindError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| ParseEventKindError(s.to_owned()))
    }
}

/// The person's decision on work waiting for review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    /// The task becomes done.
    Approve,
    /// The task returns to todo with a reason.
    Reject,
}

/// One history entry, with the title of its task for activity feeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    pub id: i64,
    pub task_id: i64,
    pub task_title: String,
    /// `user`, `github`, or the name of an AI agent.
    pub actor: String,
    pub kind: EventKind,
    pub message: String,
    pub from_status: Option<Status>,
    pub to_status: Option<Status>,
    pub created_at: String,
}

/// Appends a history entry inside the caller's transaction.
pub(crate) fn record(
    conn: &Connection,
    task_id: i64,
    actor: &Actor,
    kind: EventKind,
    message: &str,
    change: Option<(Status, Status)>,
) -> Result<i64, StoreError> {
    conn.execute(
        "INSERT INTO task_events (task_id, actor, kind, message, from_status, to_status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![
            task_id,
            actor.as_str(),
            kind.as_str(),
            message,
            change.map(|(from, _)| from.as_str()),
            change.map(|(_, to)| to.as_str())
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

const SELECT_EVENT: &str = "
SELECT e.id, e.task_id, t.title, e.actor, e.kind, e.message, e.from_status, e.to_status, e.created_at
FROM task_events e JOIN tasks t ON t.id = e.task_id";

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<Event> {
    let kind: String = row.get(4)?;
    // An unknown kind means the database is newer or damaged; say so instead of guessing.
    let kind = kind.parse::<EventKind>().map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let status = |i: usize| -> rusqlite::Result<Option<Status>> {
        Ok(row
            .get::<_, Option<String>>(i)?
            .and_then(|s| s.parse().ok()))
    };
    Ok(Event {
        id: row.get(0)?,
        task_id: row.get(1)?,
        task_title: row.get(2)?,
        actor: row.get(3)?,
        kind,
        message: row.get(5)?,
        from_status: status(6)?,
        to_status: status(7)?,
        created_at: row.get(8)?,
    })
}

fn validate_note(message: &str) -> Result<&str, StoreError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(StoreError::Invalid("the note must not be empty".into()));
    }
    let len = message.chars().count();
    if len > MAX_NOTE_CHARS {
        return Err(StoreError::Invalid(format!(
            "the note is {len} characters; the limit is {MAX_NOTE_CHARS}"
        )));
    }
    Ok(message)
}

fn exists(conn: &Connection, id: i64) -> Result<(), StoreError> {
    conn.query_row("SELECT 1 FROM tasks WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .ok_or(StoreError::NotFound(id))
}

impl Store {
    /// Adds a progress report or comment to a task's history.
    ///
    /// # Errors
    ///
    /// [`StoreError::Invalid`] for an empty or overlong note, [`StoreError::NotFound`]
    /// for an unknown task.
    pub fn add_note(
        &self,
        task_id: i64,
        actor: &Actor,
        message: &str,
    ) -> Result<Event, StoreError> {
        let message = validate_note(message)?;
        let conn = self.conn();
        exists(&conn, task_id)?;
        let id = record(&conn, task_id, actor, EventKind::Note, message, None)?;
        Ok(conn.query_row(
            &format!("{SELECT_EVENT} WHERE e.id = ?1"),
            [id],
            event_from_row,
        )?)
    }

    /// The latest `limit` history entries of one task, newest first.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn events_for(&self, task_id: i64, limit: u32) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "{SELECT_EVENT} WHERE e.task_id = ?1 ORDER BY e.id DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![task_id, limit], event_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// History entries of all tasks, newest first; `before` continues an earlier page.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn activity(&self, limit: u32, before: Option<i64>) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "{SELECT_EVENT} WHERE e.id < ?1 ORDER BY e.id DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![before.unwrap_or(i64::MAX), limit], event_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Id of the newest history entry (0 when there is none); a cheap change detector
    /// for dashboards, since agents write from other processes.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn latest_event_id(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn()
            .query_row("SELECT COALESCE(MAX(id), 0) FROM task_events", [], |r| {
                r.get(0)
            })?)
    }

    /// An agent (or person) takes a task: it becomes in progress and assigned to `actor`.
    ///
    /// `thread_id` names the conversation doing the work (for example `T3CODE_THREAD_ID`);
    /// the caller reads it, so storage never depends on the process environment.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] for an unknown task.
    pub fn start_task(
        &self,
        id: i64,
        actor: &Actor,
        thread_id: Option<&str>,
    ) -> Result<Task, StoreError> {
        let task = self.get(id)?.ok_or(StoreError::NotFound(id))?;
        let git = crate::git_evidence::capture(task.workdir.as_deref(), None);
        let mut conn = self.conn();
        let tx = write_tx(&mut conn)?;
        apply_update(
            &tx,
            id,
            &TaskUpdate {
                status: Some(Status::InProgress),
                assignee: Some(actor.as_str().to_owned()),
                ..TaskUpdate::default()
            },
            actor,
        )?;
        crate::work::open(&tx, &task, actor, thread_id, git.as_ref())?;
        record(&tx, id, actor, EventKind::Started, "", None)?;
        tx.commit()?;
        drop(conn);
        self.get(id)?.ok_or(StoreError::NotFound(id))
    }
}

impl Store {
    /// Records an agent's completion summary and completes ancestors whose children are done.
    ///
    /// # Errors
    /// Returns an error for an invalid summary, missing task or database failure.
    pub fn complete_task(&self, id: i64, agent: &Actor, summary: &str) -> Result<Task, StoreError> {
        self.complete_with_links(id, agent, summary, &[])
    }

    /// Records why work stopped, returns the task to todo and clears its assignee.
    ///
    /// # Errors
    /// Returns an error for an invalid reason, missing task or database failure.
    pub fn fail_task(&self, id: i64, agent: &Actor, reason: &str) -> Result<Task, StoreError> {
        self.report_outcome(
            id,
            agent,
            reason,
            &TaskUpdate {
                status: Some(Status::Todo),
                assignee: Some(String::new()),
                ..TaskUpdate::default()
            },
            &[],
        )
    }

    pub(crate) fn report_outcome(
        &self,
        id: i64,
        agent: &Actor,
        message: &str,
        update: &TaskUpdate,
        links: &[crate::work::WorkLink],
    ) -> Result<Task, StoreError> {
        let message = validate_note(message)?;
        for link in links {
            link.validate()?;
        }
        let task = self.get(id)?.ok_or(StoreError::NotFound(id))?;
        let sessions = self.sessions(id)?;
        let start = sessions
            .iter()
            .find(|s| s.outcome == SessionOutcome::Running)
            .and_then(|s| s.start_git.as_ref())
            .and_then(|g| g.head.as_deref());
        let git = crate::git_evidence::capture(task.workdir.as_deref(), start);
        let mut conn = self.conn();
        let tx = write_tx(&mut conn)?;
        let status: String = tx
            .query_row("SELECT status FROM tasks WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .ok_or(StoreError::NotFound(id))?;
        if status == Status::Done.as_str() && agent.is_agent() {
            return Err(StoreError::Invalid(
                "the task is already done; only the user reopens finished work".into(),
            ));
        }
        for link in links {
            crate::work::attach(&tx, id, link)?;
        }
        let (kind, outcome) = if update.status == Some(Status::Todo) {
            (EventKind::Failed, SessionOutcome::Failed)
        } else {
            (EventKind::Reported, SessionOutcome::Reported)
        };
        record(&tx, id, agent, kind, message, None)?;
        crate::work::close(&tx, id, outcome, message, git.as_ref())?;
        apply_update(&tx, id, update, agent)?;
        if update.status == Some(Status::Done) {
            complete_ancestors(&tx, id, agent)?;
        }
        tx.commit()?;
        drop(conn);
        self.get(id)?.ok_or(StoreError::NotFound(id))
    }
}

pub(crate) fn agent_done_error() -> StoreError {
    StoreError::Invalid(
        "AI cannot mark tasks done; use complete_task / stk done to send work for user review"
            .into(),
    )
}
impl Store {
    /// Approves a report or returns it to todo with a reason.
    ///
    /// # Errors
    ///
    /// Rejects non-user actors, non-review tasks and blank rejection reasons.
    pub fn review_task(
        &self,
        id: i64,
        actor: &Actor,
        decision: ReviewDecision,
        comment: &str,
    ) -> Result<Task, StoreError> {
        if *actor != Actor::User {
            return Err(agent_done_error());
        }
        let approve = decision == ReviewDecision::Approve;
        let comment = if approve && comment.trim().is_empty() {
            ""
        } else {
            validate_note(comment)?
        };
        self.record_review(id, actor, decision, comment)
    }

    /// Records an approval or rejection the person gave an AI agent in a conversation, so
    /// the person need not open the dashboard to repeat it. The history names the agent
    /// that recorded it and keeps the person's words, so it stays apart from approvals the
    /// person made themselves. Agents must never call this on their own judgment.
    ///
    /// # Errors
    ///
    /// Rejects actors that are not agents, blank `user_said`, and tasks not under review.
    pub fn review_for_user(
        &self,
        id: i64,
        agent: &Actor,
        decision: ReviewDecision,
        user_said: &str,
    ) -> Result<Task, StoreError> {
        if !agent.is_agent() {
            return Err(StoreError::Invalid(
                "only an AI agent records a review for the user; the user reviews directly".into(),
            ));
        }
        let user_said = validate_note(user_said).map_err(|_| {
            StoreError::Invalid("quote what the user said (1-4000 characters)".into())
        })?;
        self.record_review(id, agent, decision, user_said)
    }

    fn record_review(
        &self,
        id: i64,
        actor: &Actor,
        decision: ReviewDecision,
        comment: &str,
    ) -> Result<Task, StoreError> {
        let approve = decision == ReviewDecision::Approve;
        let mut conn = self.conn();
        let tx = write_tx(&mut conn)?;
        let status: String = tx
            .query_row("SELECT status FROM tasks WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .ok_or(StoreError::NotFound(id))?;
        if status != "review" {
            return Err(StoreError::Invalid(
                "確認中のタスクだけ承認・差し戻しできます".into(),
            ));
        }
        apply_update(
            &tx,
            id,
            &TaskUpdate {
                status: Some(if approve { Status::Done } else { Status::Todo }),
                assignee: if approve { None } else { Some(String::new()) },
                ..TaskUpdate::default()
            },
            actor,
        )?;
        record(
            &tx,
            id,
            actor,
            if approve {
                EventKind::Approved
            } else {
                EventKind::Rejected
            },
            comment,
            None,
        )?;
        if approve {
            complete_ancestors(&tx, id, actor)?;
        }
        tx.commit()?;
        drop(conn);
        self.get(id)?.ok_or(StoreError::NotFound(id))
    }
}
