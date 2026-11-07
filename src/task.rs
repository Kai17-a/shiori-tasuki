use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Progress state of a task; matches the columns of the admin board.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Todo,
    InProgress,
    Review,
    Done,
}

impl Status {
    pub const ALL: [Self; 4] = [Self::Todo, Self::InProgress, Self::Review, Self::Done];

    /// The identifier stored in the database and used by every interface.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Review => "review",
            Self::Done => "done",
        }
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned when a string is not one of the known [`Status`] values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown status {0:?} (expected todo, in_progress, review or done)")]
pub struct ParseStatusError(String);

impl FromStr for Status {
    type Err = ParseStatusError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == s)
            .ok_or_else(|| ParseStatusError(s.to_owned()))
    }
}

/// The GitHub issue a task mirrors or was published to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubLink {
    /// Repository in `owner/name` form.
    pub repo: String,
    pub number: u32,
    pub url: String,
}

/// How many direct subtasks a task has and how many of them are done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SubtaskSummary {
    pub total: u32,
    pub done: u32,
}

/// A stored task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub title: String,
    pub description: String,
    pub status: Status,
    /// Who created the task: `user`, `github`, or the name of an AI agent.
    pub created_by: String,
    pub github: Option<GithubLink>,
    pub subtasks: SubtaskSummary,
    /// RFC 3339 timestamps in UTC.
    pub created_at: String,
    pub updated_at: String,
    /// When the task last became done; `None` while it is not done.
    pub completed_at: Option<String>,
    /// Who is working on the task: a person or the name of an AI agent.
    pub assignee: Option<String>,
    /// Time of the latest history entry; tells whether work has stalled.
    pub last_activity_at: String,
    /// Folder the user asks an agent to work in.
    pub workdir: Option<String>,
    /// Historical execution count, retained for database compatibility.
    pub attempts: u32,
}

impl Task {
    /// Whether an external source owns this task's title and description.
    pub fn is_external(&self) -> bool {
        self.github.is_some()
    }
}

/// Input for creating a task from any interface.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(default)]
pub struct NewTask {
    pub title: String,
    pub description: String,
    pub parent_id: Option<i64>,
    pub status: Option<Status>,
    /// Defaults to the person when absent.
    pub created_by: Option<crate::Actor>,
    /// Folder an agent should work in; subtasks inherit their parent's.
    pub workdir: Option<String>,
}

/// One child task proposed by an AI agent (or a person) for an existing parent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NewSubtask {
    pub title: String,
    #[serde(default)]
    pub description: String,
}

/// Partial update; `None` fields are left unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(default)]
pub struct TaskUpdate {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<Status>,
    /// `Some("")` clears the assignee.
    pub assignee: Option<String>,
}
