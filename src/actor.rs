//! Who did something: the person, the GitHub sync, or a named AI agent.
//!
//! Only the person may approve work, so the kind of actor is a type rather than a name
//! compared against strings at each check.

use std::fmt;

use serde::{Deserialize, Serialize};

/// The person, the GitHub sync, or an AI agent identified by its name.
///
/// Stored and serialized as its name: `user`, `github`, or the agent's name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum Actor {
    /// The person who owns the task list.
    User,
    /// The background GitHub sync.
    Github,
    /// An AI agent such as `claude-code` or `codex`.
    Agent(String),
}

impl Actor {
    const USER: &'static str = "user";
    const GITHUB: &'static str = "github";

    /// An agent named `name`, or `None` when the name is empty or belongs to the person
    /// or the GitHub sync. Use this for names that come from an agent itself, so it cannot
    /// claim the person's rights.
    #[must_use]
    pub fn agent(name: &str) -> Option<Self> {
        let name = name.trim();
        (!name.is_empty() && name != Self::USER && name != Self::GITHUB)
            .then(|| Self::Agent(name.to_owned()))
    }

    /// The name stored in the history and shown by every interface.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => Self::USER,
            Self::Github => Self::GITHUB,
            Self::Agent(name) => name,
        }
    }

    /// Whether this is an AI agent rather than the person or the GitHub sync.
    #[must_use]
    pub fn is_agent(&self) -> bool {
        matches!(self, Self::Agent(_))
    }
}

/// Reads a name chosen by the person (`--as`, `TASK_MANAGER_ACTOR`) or stored in the
/// database: `user` and `github` are the person and the sync, anything else an agent.
impl From<&str> for Actor {
    fn from(name: &str) -> Self {
        match name {
            Self::USER => Self::User,
            Self::GITHUB => Self::Github,
            other => Self::Agent(other.to_owned()),
        }
    }
}

impl From<String> for Actor {
    fn from(name: String) -> Self {
        match name.as_str() {
            Self::USER => Self::User,
            Self::GITHUB => Self::Github,
            _ => Self::Agent(name),
        }
    }
}

impl From<Actor> for String {
    fn from(actor: Actor) -> Self {
        match actor {
            Actor::Agent(name) => name,
            other => other.as_str().to_owned(),
        }
    }
}

impl fmt::Display for Actor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::Actor;

    #[test]
    fn names_map_to_kinds() {
        assert_eq!(Actor::from("user"), Actor::User);
        assert_eq!(Actor::from("github"), Actor::Github);
        assert_eq!(Actor::from("codex"), Actor::Agent("codex".into()));
        assert_eq!(Actor::from("codex").as_str(), "codex");
    }

    #[test]
    fn agents_cannot_take_reserved_names() {
        assert_eq!(Actor::agent("user"), None);
        assert_eq!(Actor::agent("github"), None);
        assert_eq!(Actor::agent("  "), None);
        assert_eq!(
            Actor::agent(" claude-code "),
            Some(Actor::Agent("claude-code".into()))
        );
    }
}
