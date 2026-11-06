//! Aggregates shown on the admin dashboard.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::store::{SELECT, Store, StoreError, task_from_row};
use crate::task::Task;

/// In-progress work with no history entry for this long counts as stalled: the agent
/// may have stopped, crashed or be waiting for something.
pub const STALL_AFTER_SECS: u64 = 2 * 60 * 60;

/// Number of days covered by [`Stats::daily`], ending today (server local time).
pub const DAILY_WINDOW_DAYS: u32 = 14;

/// How many tasks [`Stats::recent`] holds.
const RECENT_LIMIT: u32 = 30;

/// How many parents [`Stats::with_subtasks`] holds.
const PROGRESS_LIMIT: u32 = 50;

/// Task counts per status, over every task including subtasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct StatusCounts {
    pub todo: u32,
    pub in_progress: u32,
    pub review: u32,
    pub done: u32,
}

/// Tasks created and completed on one UTC day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DailyCount {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub created: u32,
    pub completed: u32,
}

/// Top-level tasks per GitHub repository; `repo` is `None` for local tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoCount {
    pub repo: Option<String>,
    pub open: u32,
    pub done: u32,
}

/// Tasks per creator (`user`, `github`, or an AI agent name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CreatorCount {
    pub created_by: String,
    pub count: u32,
}

/// What one AI agent is doing, derived from assignments and task history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentSummary {
    pub name: String,
    /// In-progress tasks assigned to the agent.
    pub working: u32,
    /// Of `working`, how many have had no activity for [`STALL_AFTER_SECS`].
    pub stalled: u32,
    /// Tasks done today that the agent worked on: assigned to it or marked done by it.
    pub done_today: u32,
    pub last_activity_at: Option<String>,
}

/// Everything the dashboard shows, computed in one pass over the database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stats {
    pub total: u32,
    pub by_status: StatusCounts,
    pub completed_last_7_days: u32,
    /// Oldest day first, [`DAILY_WINDOW_DAYS`] entries.
    pub daily: Vec<DailyCount>,
    /// Local tasks first, then repositories by name.
    pub by_repo: Vec<RepoCount>,
    /// Most tasks first.
    pub by_creator: Vec<CreatorCount>,
    /// Most recently updated first.
    pub recent: Vec<Task>,
    /// Unfinished tasks that have subtasks, least complete first.
    pub with_subtasks: Vec<Task>,
    /// Tasks that became done today (server local time).
    pub completed_today: u32,
    /// In-progress tasks without activity for [`STALL_AFTER_SECS`], oldest first.
    pub stalled: Vec<Task>,
    /// Agents with the most recent activity first. People and the GitHub sync
    /// itself are excluded.
    pub agents: Vec<AgentSummary>,
    pub stall_after_secs: u64,
    pub awaiting_review: Vec<ReviewSummary>,
}

/// Report waiting for the user's decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewSummary {
    pub task: Task,
    pub agent: String,
    pub reported_at: String,
    pub summary: String,
}

impl Store {
    /// Summarises all tasks for the dashboard.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn stats(&self) -> Result<Stats, StoreError> {
        let conn = self.conn();
        let cutoff = stall_cutoff();
        let mut by_status = StatusCounts::default();
        let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM tasks GROUP BY status")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))? {
            let (status, count) = row?;
            match status.as_str() {
                "todo" => by_status.todo = count,
                "in_progress" => by_status.in_progress = count,
                "review" => by_status.review = count,
                "done" => by_status.done = count,
                _ => {}
            }
        }
        let total = by_status.todo + by_status.in_progress + by_status.review + by_status.done;

        Ok(Stats {
            awaiting_review: collect(&conn, &format!("{SELECT} WHERE t.status = 'review' ORDER BY t.updated_at"), task_from_row)?.into_iter().map(|task| {
                let report: (String,String,String) = conn.query_row("SELECT actor,created_at,message FROM task_events WHERE task_id=?1 AND kind='reported' ORDER BY id DESC LIMIT 1", [task.id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap_or((task.assignee.clone().unwrap_or_default(),task.updated_at.clone(),String::new()));
                ReviewSummary { task,agent:report.0,reported_at:report.1,summary:report.2.lines().next().unwrap_or_default().to_owned() }
            }).collect(),
            total,
            by_status,
            completed_last_7_days: conn.query_row(
                "SELECT COUNT(*) FROM tasks
                 WHERE status = 'done' AND completed_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')",
                [],
                |r| r.get(0),
            )?,
            daily: daily(&conn)?,
            by_repo: collect(
                &conn,
                "SELECT gh_repo, SUM(status != 'done'), SUM(status = 'done') FROM tasks
                 WHERE parent_id IS NULL GROUP BY gh_repo ORDER BY gh_repo IS NOT NULL, gh_repo",
                |r| {
                    Ok(RepoCount {
                        repo: r.get(0)?,
                        open: r.get(1)?,
                        done: r.get(2)?,
                    })
                },
            )?,
            by_creator: collect(
                &conn,
                "SELECT created_by, COUNT(*) FROM tasks GROUP BY created_by
                 ORDER BY COUNT(*) DESC, created_by",
                |r| {
                    Ok(CreatorCount {
                        created_by: r.get(0)?,
                        count: r.get(1)?,
                    })
                },
            )?,
            recent: collect(
                &conn,
                &format!("{SELECT} ORDER BY t.updated_at DESC, t.id DESC LIMIT {RECENT_LIMIT}"),
                task_from_row,
            )?,
            completed_today: conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE status = 'done'
                 AND date(completed_at, 'localtime') = date('now', 'localtime')",
                [],
                |r| r.get(0),
            )?,
            stalled: collect(
                &conn,
                &format!(
                    "SELECT * FROM ({SELECT}) AS s
                     WHERE s.status = 'in_progress' AND s.last_activity_at < {cutoff}
                       AND NOT EXISTS (SELECT 1 FROM tasks c
                                       WHERE c.parent_id = s.id AND c.status != 'done')
                     ORDER BY s.last_activity_at"
                ),
                task_from_row,
            )?,
            agents: agents(&conn)?,
            stall_after_secs: STALL_AFTER_SECS,
            with_subtasks: collect(
                &conn,
                &format!(
                    "SELECT * FROM ({SELECT} WHERE t.status != 'done') AS s
                     WHERE s.subtask_total > 0
                     ORDER BY CAST(s.subtask_done AS REAL) / s.subtask_total, s.id
                     LIMIT {PROGRESS_LIMIT}"
                ),
                task_from_row,
            )?,
        })
    }
}

/// SQL expression for the moment before which in-progress work counts as stalled.
fn stall_cutoff() -> String {
    format!("strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-{STALL_AFTER_SECS} seconds')")
}

fn agents(conn: &Connection) -> Result<Vec<AgentSummary>, StoreError> {
    let cutoff = stall_cutoff();
    collect(
        conn,
        &format!(
            "WITH names(name) AS (
                SELECT actor FROM task_events
                UNION SELECT assignee FROM tasks WHERE assignee IS NOT NULL
                UNION SELECT created_by FROM tasks
             ),
             activity AS (
                SELECT t.id, t.status, t.assignee, t.completed_at,
                       COALESCE((SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = t.id),
                                t.updated_at) AS last_at
                FROM tasks t
             )
             SELECT n.name,
                (SELECT COUNT(*) FROM activity a WHERE a.status = 'in_progress' AND a.assignee = n.name),
                (SELECT COUNT(*) FROM activity a WHERE a.status = 'in_progress' AND a.assignee = n.name
                    AND a.last_at < {cutoff}),
                (SELECT COUNT(*) FROM activity a WHERE a.status = 'done'
                    AND date(a.completed_at, 'localtime') = date('now', 'localtime')
                    AND (a.assignee = n.name
                         OR EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = a.id
                                    AND e.kind = 'status' AND e.to_status = 'done'
                                    AND e.actor = n.name))),
                (SELECT MAX(e.created_at) FROM task_events e WHERE e.actor = n.name) AS last_at
             FROM names n
             WHERE n.name NOT IN ('user', 'github')
             ORDER BY last_at IS NULL, last_at DESC, n.name"
        ),
        |r| {
            Ok(AgentSummary {
                name: r.get(0)?,
                working: r.get(1)?,
                stalled: r.get(2)?,
                done_today: r.get(3)?,
                last_activity_at: r.get(4)?,
            })
        },
    )
}

fn daily(conn: &Connection) -> Result<Vec<DailyCount>, StoreError> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE days(d) AS (
            SELECT date('now', 'localtime', ?1)
            UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now', 'localtime')
         )
         SELECT d,
                (SELECT COUNT(*) FROM tasks WHERE date(created_at, 'localtime') = d),
                (SELECT COUNT(*) FROM tasks
                  WHERE status = 'done' AND date(completed_at, 'localtime') = d)
         FROM days ORDER BY d",
    )?;
    let offset = format!("-{} days", DAILY_WINDOW_DAYS - 1);
    let rows = stmt.query_map(params![offset], |r| {
        Ok(DailyCount {
            date: r.get(0)?,
            created: r.get(1)?,
            completed: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn collect<T>(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, StoreError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<Result<_, _>>()?)
}
