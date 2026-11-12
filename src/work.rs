//! Work attempts and the chronological history of a task family.
use std::fmt;
use std::str::FromStr;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::write_tx;
use crate::{Actor, Scope, Store, StoreError, Task, activity::Event, git_evidence::GitEvidence};

/// A user-supplied artifact URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkLink {
    pub url: String,
    pub label: Option<String>,
}
impl WorkLink {
    /// Accepts only absolute HTTP(S) links.
    ///
    /// # Errors
    ///
    /// Returns an error for other schemes or a missing host.
    pub fn validate(&self) -> Result<(), StoreError> {
        let uri: axum::http::Uri = self
            .url
            .parse()
            .map_err(|_| StoreError::Invalid("link must be an http(s) URL".into()))?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.host().is_none_or(str::is_empty)
        {
            return Err(StoreError::Invalid("link must be an http(s) URL".into()));
        }
        Ok(())
    }
}

/// How a work attempt ended, or that it is still going.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOutcome {
    Running,
    /// The agent reported the work for review (or a person finished it).
    Reported,
    Failed,
    /// Replaced by a later start of the same task.
    Abandoned,
}

impl SessionOutcome {
    const ALL: [Self; 4] = [Self::Running, Self::Reported, Self::Failed, Self::Abandoned];

    /// The identifier stored in the database and shown by every interface.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Reported => "reported",
            Self::Failed => "failed",
            Self::Abandoned => "abandoned",
        }
    }
}

impl fmt::Display for SessionOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned when a string is not one of the known [`SessionOutcome`] values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown work session outcome {0:?}")]
pub struct ParseOutcomeError(String);

impl FromStr for SessionOutcome {
    type Err = ParseOutcomeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|outcome| outcome.as_str() == s)
            .ok_or_else(|| ParseOutcomeError(s.to_owned()))
    }
}

/// One attempt, including immutable start/end snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkSession {
    pub id: i64,
    pub task_id: i64,
    pub agent: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub outcome: SessionOutcome,
    pub thread_id: Option<String>,
    pub workdir: Option<String>,
    pub start_git: Option<GitEvidence>,
    pub end_git: Option<GitEvidence>,
    pub summary: String,
    pub links: Vec<WorkLink>,
}
/// Stores git evidence as JSON; these plain structs always serialize.
fn evidence_json(git: Option<&GitEvidence>) -> Option<String> {
    git.and_then(|g| serde_json::to_string(g).ok())
}

/// Starts a new attempt, ending any attempt of the same task that is still running.
pub(crate) fn open(
    conn: &Connection,
    task: &Task,
    actor: &Actor,
    thread_id: Option<&str>,
    git: Option<&GitEvidence>,
) -> Result<(), StoreError> {
    conn.execute(
        "UPDATE work_sessions SET outcome = ?2, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE task_id = ?1 AND outcome = ?3",
        params![
            task.id,
            SessionOutcome::Abandoned.as_str(),
            SessionOutcome::Running.as_str()
        ],
    )?;
    conn.execute(
        "INSERT INTO work_sessions (task_id, agent, thread_id, workdir, start_git)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            task.id,
            actor.as_str(),
            thread_id,
            task.workdir,
            evidence_json(git)
        ],
    )?;
    Ok(())
}

/// Ends the running attempt of a task with its outcome, summary and final evidence.
pub(crate) fn close(
    conn: &Connection,
    id: i64,
    outcome: SessionOutcome,
    summary: &str,
    git: Option<&GitEvidence>,
) -> Result<(), StoreError> {
    conn.execute(
        "UPDATE work_sessions SET outcome = ?2, summary = ?3, end_git = ?4,
            ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE task_id = ?1 AND outcome = ?5",
        params![
            id,
            outcome.as_str(),
            summary,
            evidence_json(git),
            SessionOutcome::Running.as_str()
        ],
    )?;
    Ok(())
}
/// One family timeline item, tagged with its task.
#[derive(Debug, Serialize)]
pub struct TimelineItem {
    pub task_id: i64,
    pub task_title: String,
    pub at: String,
    pub event: Option<Event>,
    pub session: Option<WorkSession>,
    #[serde(skip)]
    order: i64,
}
impl Store {
    /// Reads attempts in start order.
    ///
    /// # Errors
    ///
    /// Returns database errors, including an outcome this program does not know.
    pub fn sessions(&self, id: i64) -> Result<Vec<WorkSession>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, task_id, agent, started_at, ended_at, outcome, thread_id, workdir,
                start_git, end_git, summary, links
             FROM work_sessions WHERE task_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([id], |r| {
            let outcome: String = r.get(5)?;
            let outcome = outcome.parse::<SessionOutcome>().map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            let decode = |i| -> rusqlite::Result<Option<GitEvidence>> {
                Ok(r.get::<_, Option<String>>(i)?
                    .and_then(|s| serde_json::from_str(&s).ok()))
            };
            Ok(WorkSession {
                id: r.get(0)?,
                task_id: r.get(1)?,
                agent: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                outcome,
                thread_id: r.get(6)?,
                workdir: r.get(7)?,
                start_git: decode(8)?,
                end_git: decode(9)?,
                summary: r.get(10)?,
                links: serde_json::from_str(&r.get::<_, String>(11)?).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    /// Adds a link to the current or most recent attempt.
    ///
    /// # Errors
    ///
    /// Rejects invalid URLs or tasks without an attempt.
    pub fn add_link(&self, id: i64, link: &WorkLink) -> Result<(), StoreError> {
        link.validate()?;
        let mut conn = self.conn();
        let tx = write_tx(&mut conn)?;
        attach(&tx, id, link)?;
        tx.commit()?;
        Ok(())
    }
    /// Reports with validated artifact links.
    ///
    /// # Errors
    ///
    /// Returns validation or storage errors.
    pub fn complete_with_links(
        &self,
        id: i64,
        actor: &Actor,
        summary: &str,
        links: &[WorkLink],
    ) -> Result<Task, StoreError> {
        self.report_outcome(
            id,
            actor,
            summary,
            &crate::TaskUpdate {
                status: Some(if actor.is_agent() {
                    crate::Status::Review
                } else {
                    crate::Status::Done
                }),
                ..crate::TaskUpdate::default()
            },
            links,
        )
    }

    /// Returns history and sessions for the root and all descendants, oldest first.
    ///
    /// # Errors
    ///
    /// Returns missing-task or storage errors.
    pub fn timeline(&self, id: i64) -> Result<Vec<TimelineItem>, StoreError> {
        let mut root = self.get(id)?.ok_or(StoreError::NotFound(id))?;
        while let Some(parent) = root.parent_id {
            root = self.get(parent)?.ok_or(StoreError::NotFound(parent))?;
        }
        let mut queue = vec![root];
        let mut items = Vec::new();
        while let Some(task) = queue.pop() {
            queue.extend(self.list(Scope::ChildrenOf(task.id))?);
            let mut events = self.events_for(task.id, u32::MAX)?;
            events.reverse();
            let starts: Vec<_> = events
                .iter()
                .filter(|e| e.kind == crate::activity::EventKind::Started)
                .map(|e| e.id)
                .collect();
            for event in events {
                items.push(TimelineItem {
                    task_id: task.id,
                    task_title: task.title.clone(),
                    at: event.created_at.clone(),
                    order: event.id,
                    event: Some(event),
                    session: None,
                });
            }
            for (index, session) in self.sessions(task.id)?.into_iter().enumerate() {
                items.push(TimelineItem {
                    task_id: task.id,
                    task_title: task.title.clone(),
                    at: session.started_at.clone(),
                    event: None,
                    session: Some(session),
                    order: starts.get(index).copied().unwrap_or(i64::MAX),
                });
            }
        }
        items.sort_by(|a, b| {
            normalized_time(&a.at)
                .cmp(&normalized_time(&b.at))
                .then_with(|| a.order.cmp(&b.order))
                .then_with(|| a.event.is_some().cmp(&b.event.is_some()))
        });
        Ok(items)
    }
}

fn normalized_time(at: &str) -> String {
    if at.contains('.') {
        at.to_owned()
    } else {
        at.replace('Z', ".000Z")
    }
}

/// Appends a link to the task's latest attempt.
pub(crate) fn attach(conn: &Connection, id: i64, link: &WorkLink) -> Result<(), StoreError> {
    let (sid, data): (i64, String) = conn
        .query_row(
            "SELECT id, links FROM work_sessions WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("start the task before attaching links".into()))?;
    let mut links: Vec<WorkLink> = serde_json::from_str(&data).unwrap_or_default();
    links.push(link.clone());
    let links = serde_json::to_string(&links)
        .map_err(|e| StoreError::Invalid(format!("cannot store the links: {e}")))?;
    conn.execute(
        "UPDATE work_sessions SET links = ?2 WHERE id = ?1",
        params![sid, links],
    )?;
    Ok(())
}
