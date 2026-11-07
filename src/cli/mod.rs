mod output;

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use task_tool::github::{self, GhCli};
use task_tool::{
    Actor, INSTRUCTIONS, NewSubtask, NewTask, ReviewDecision, Scope, Status, Store, Task,
    TaskUpdate,
};

/// Personal task list for people and AI agents. Writes are non-interactive.
///
/// Use guide for the agent workflow. serve and mcp sync your GitHub issues in the background.
#[derive(Debug, Parser)]
#[command(version)]
#[expect(
    clippy::doc_markdown,
    reason = "clap prints these doc comments as --help text, where backticks would show"
)]
pub(crate) struct Cli {
    /// Database: --db > TASK_TOOL_DB > $XDG_DATA_HOME/task-tool/tasks.db > $HOME/.local/share/task-tool/tasks.db. Parent folders are created.
    #[arg(long, global = true, env = "TASK_TOOL_DB")]
    db: Option<PathBuf>,
    /// Actor recorded in history; defaults to claude-code for CLAUDECODE=1, otherwise user. Codex: --as codex.
    #[arg(long = "as", global = true, env = "TASK_TOOL_ACTOR")]
    actor: Option<String>,
    /// GitHub repository (owner/name): list filter or default for gh push.
    #[arg(long, global = true, env = "TASK_TOOL_REPO")]
    pub(crate) repo: Option<String>,
    /// Print JSON; optionally select comma-separated top-level fields. View fields: task,subtasks,history.
    #[arg(long, global = true, num_args = 0..=1, default_missing_value = "", value_name = "FIELDS")]
    json: Option<String>,
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Debug, Subcommand)]
#[expect(
    clippy::doc_markdown,
    reason = "clap prints these doc comments as --help text, where backticks would show"
)]
pub(crate) enum Command {
    /// Serve the dashboard and JSON API; sync GitHub issues every 5 minutes.
    Serve {
        /// Listen address; loopback is recommended because the API has no login.
        #[arg(long, default_value = "127.0.0.1:7878")]
        addr: SocketAddr,
    },
    /// Run the MCP server on stdio and sync GitHub issues.
    Mcp,
    /// Create a task. Top-level workdir defaults to cwd; subtasks inherit it.
    #[command(visible_alias = "add")]
    Create {
        title: String,
        /// Description; - reads stdin. --description and -d are compatibility aliases.
        #[arg(
            short = 'b',
            long,
            visible_alias = "description",
            short_alias = 'd',
            default_value = ""
        )]
        body: String,
        #[arg(short, long)]
        parent: Option<i64>,
        #[arg(short, long)]
        workdir: Option<PathBuf>,
    },
    /// List top-level tasks in creation order; filters combine with AND.
    List {
        /// Include any of these statuses: todo, in_progress, review, done. Repeatable.
        #[arg(long)]
        status: Vec<Status>,
        #[arg(long)]
        assignee: Option<String>,
        /// Only families whose root has no GitHub link.
        #[arg(long, conflicts_with = "repo")]
        local: bool,
        /// Case-insensitive title/description substring.
        #[arg(long)]
        search: Option<String>,
        /// Direct children of this task.
        #[arg(short, long)]
        parent: Option<i64>,
        /// Include subtasks at every level.
        #[arg(long, conflicts_with = "parent")]
        all: bool,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Show a task, direct subtasks and recent history. JSON keys: task,subtasks,history.
    #[command(visible_alias = "show")]
    View {
        id: i64,
        #[arg(long, default_value_t = 20)]
        history: u32,
    },
    /// Edit fields; linked title/body must be edited on GitHub.
    #[command(visible_alias = "update")]
    Edit {
        id: i64,
        #[arg(long)]
        title: Option<String>,
        /// Description; - reads stdin.
        #[arg(short = 'b', long, visible_alias = "description")]
        body: Option<String>,
        /// todo, in_progress, review or done.
        #[arg(long)]
        status: Option<Status>,
        /// Empty string clears the assignee.
        #[arg(long)]
        assignee: Option<String>,
    },
    /// Start work: set in_progress and assign to the acting agent/person.
    Start { id: i64 },
    /// Report work for user review; user actors finish directly.
    Done {
        id: i64,
        /// What changed and how it was verified; - reads stdin.
        #[arg(long)]
        summary: String,
        #[arg(long = "link")]
        links: Vec<String>,
    },
    /// Approve a reported task (user only).
    Approve {
        id: i64,
        #[arg(long, default_value = "")]
        comment: String,
    },
    /// Return a report for another attempt (user only).
    Reject {
        id: i64,
        #[arg(long)]
        reason: String,
    },
    /// Attach an artifact URL to the latest work session.
    Link {
        id: i64,
        url: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Record the reason, return to todo and clear the assignee.
    Fail {
        id: i64,
        /// Why work stopped; - reads stdin.
        #[arg(long)]
        reason: String,
    },
    /// Create subtasks atomically from one or more titles (descriptions start empty).
    Split {
        id: i64,
        #[arg(required = true, num_args = 1..)]
        titles: Vec<String>,
    },
    /// Record a progress note; message - reads stdin.
    #[command(visible_alias = "comment")]
    Note { id: i64, message: String },
    /// Delete a task and all descendants; requires --yes, never prompts.
    #[command(visible_alias = "rm")]
    Delete {
        id: i64,
        #[arg(long)]
        yes: bool,
    },
    /// Recent history, newest first, optionally for one task.
    Activity {
        #[arg(long, default_value_t = 30)]
        limit: u32,
        #[arg(long)]
        task: Option<i64>,
    },
    /// Dashboard statistics over all tasks including subtasks.
    Stats,
    /// Print the shared MCP/CLI agent workflow; no database needed.
    Guide,
    /// GitHub integration through the authenticated gh CLI.
    #[command(subcommand)]
    Gh(GhCommand),
}

#[derive(Debug, Subcommand)]
#[expect(
    clippy::doc_markdown,
    reason = "clap prints these doc comments as --help text, where backticks would show"
)]
pub(crate) enum GhCommand {
    /// Create an issue assigned to you and link the resulting task.
    Push {
        id: i64,
        /// owner/name; overrides the global --repo / TASK_TOOL_REPO default.
        #[arg(value_name = "REPO")]
        repository: Option<String>,
    },
}

impl Cli {
    pub(crate) fn database(&self) -> Result<PathBuf> {
        if let Some(db) = &self.db {
            return Ok(db.clone());
        }
        if let Some(data) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(data).join("task-tool/tasks.db"));
        }
        let home = std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .context("HOME is not set; set --db, TASK_TOOL_DB or XDG_DATA_HOME")?;
        Ok(PathBuf::from(home).join(".local/share/task-tool/tasks.db"))
    }

    fn actor(&self) -> Result<Actor> {
        let actor = self.actor.clone().unwrap_or_else(|| {
            if std::env::var("CLAUDECODE").as_deref() == Ok("1") {
                "claude-code".into()
            } else {
                "user".into()
            }
        });
        let actor = actor.trim();
        if actor.is_empty() {
            bail!("actor must not be empty; use --as NAME or TASK_TOOL_ACTOR");
        }
        Ok(Actor::from(actor))
    }

    pub(crate) fn validate_output(&self) -> Result<()> {
        output::validate(self.json.as_deref(), &self.command)
    }

    pub(crate) fn print_guide(&self) -> Result<()> {
        output::print(
            &json!({"instructions": INSTRUCTIONS}),
            self.json.as_deref(),
            &self.command,
        )
    }

    pub(crate) fn execute(&self, store: &Store) -> Result<()> {
        let value = match self.read(store)? {
            Some(value) => value,
            None => self.write(store, self.actor()?)?,
        };
        output::print(&value, self.json.as_deref(), &self.command)
    }

    /// Runs a command that only reads; `None` for commands that change something.
    fn read(&self, store: &Store) -> Result<Option<Value>> {
        let value = match &self.command {
            Command::List {
                status,
                assignee,
                local,
                search,
                parent,
                all,
                limit,
            } => {
                let filter = ListFilter {
                    status,
                    assignee: assignee.as_deref(),
                    local: *local,
                    search: search.as_deref(),
                    parent: *parent,
                    all: *all,
                    limit: *limit,
                };
                serde_json::to_value(self.list(store, &filter)?)?
            }
            Command::View { id, history } => json!({
                "task": get(store, *id)?, "subtasks": store.list(Scope::ChildrenOf(*id))?,
                "history": store.events_for(*id, *history)?,
                    "sessions": store.sessions(*id)?,
            }),
            Command::Activity { limit, task } => serde_json::to_value(match task {
                Some(id) => {
                    get(store, *id)?;
                    store.events_for(*id, *limit)?
                }
                None => store.activity(*limit, None)?,
            })?,
            Command::Stats => serde_json::to_value(store.stats()?)?,
            _ => return Ok(None),
        };
        Ok(Some(value))
    }

    /// Runs a command that changes tasks, recorded as done by `actor`.
    fn write(&self, store: &Store, actor: Actor) -> Result<Value> {
        let value = match &self.command {
            Command::Create {
                title,
                body,
                parent,
                workdir,
            } => serde_json::to_value(create(
                store,
                actor,
                title,
                body,
                *parent,
                workdir.as_deref(),
            )?)?,
            Command::Edit {
                id,
                title,
                body,
                status,
                assignee,
            } => {
                let update = TaskUpdate {
                    title: title.clone(),
                    description: body.as_deref().map(text).transpose()?,
                    status: *status,
                    assignee: assignee.clone(),
                };
                serde_json::to_value(store.update_as(*id, &update, &actor)?)?
            }
            Command::Start { id } => serde_json::to_value(store.start_task(
                *id,
                &actor,
                std::env::var("T3CODE_THREAD_ID").ok().as_deref(),
            )?)?,
            Command::Done { id, summary, links } => {
                let links: Vec<_> = links
                    .iter()
                    .map(|url| task_tool::work::WorkLink {
                        url: url.clone(),
                        label: None,
                    })
                    .collect();
                serde_json::to_value(store.complete_with_links(
                    *id,
                    &actor,
                    &text(summary)?,
                    &links,
                )?)?
            }
            Command::Approve { id, comment } => {
                review(store, &actor, *id, ReviewDecision::Approve, comment)?
            }
            Command::Reject { id, reason } => {
                review(store, &actor, *id, ReviewDecision::Reject, reason)?
            }
            Command::Link { id, url, label } => {
                store.add_link(
                    *id,
                    &task_tool::work::WorkLink {
                        url: url.clone(),
                        label: label.clone(),
                    },
                )?;
                json!({"sessions": store.sessions(*id)?})
            }
            Command::Fail { id, reason } => {
                serde_json::to_value(store.fail_task(*id, &actor, &text(reason)?)?)?
            }
            Command::Split { id, titles } => {
                let subtasks: Vec<_> = titles
                    .iter()
                    .map(|t| NewSubtask {
                        title: t.clone(),
                        description: String::new(),
                    })
                    .collect();
                serde_json::to_value(store.create_subtasks(*id, &subtasks, &actor)?)?
            }
            Command::Note { id, message } => {
                serde_json::to_value(store.add_note(*id, &actor, &text(message)?)?)?
            }
            Command::Delete { id, yes } => {
                if !yes {
                    bail!("deleting task {id} and its descendants requires --yes");
                }
                delete(store, *id)?
            }
            Command::Gh(GhCommand::Push { id, repository }) => {
                serde_json::to_value(self.push(store, *id, repository.as_deref())?)?
            }
            Command::List { .. }
            | Command::View { .. }
            | Command::Activity { .. }
            | Command::Stats => bail!("{:?} only reads", self.command),
            Command::Guide | Command::Serve { .. } | Command::Mcp => {
                bail!("guide, serve and mcp are run by main")
            }
        };
        Ok(value)
    }
}

/// The `list` filters; every one that is set must match.
struct ListFilter<'a> {
    status: &'a [Status],
    assignee: Option<&'a str>,
    /// Only tasks outside any GitHub repository.
    local: bool,
    search: Option<&'a str>,
    parent: Option<i64>,
    /// Subtasks too, not only top-level tasks.
    all: bool,
    limit: usize,
}

impl Cli {
    fn list(&self, store: &Store, filter: &ListFilter<'_>) -> Result<Vec<Task>> {
        if let Some(id) = filter.parent {
            get(store, id)?;
        }
        let tasks = store.list(Scope::All)?;
        let by_id: HashMap<i64, &Task> = tasks.iter().map(|t| (t.id, t)).collect();
        // A subtask belongs to the repository of its top-level task.
        let repo_of = |task: &Task| {
            let mut root = task;
            while let Some(parent) = root.parent_id.and_then(|id| by_id.get(&id)) {
                root = parent;
            }
            root.github.as_ref().map(|g| g.repo.clone())
        };
        let search = filter.search.map(str::to_lowercase);
        let matches = |t: &Task| {
            let scope_matches = match filter.parent {
                Some(id) => t.parent_id == Some(id),
                None => filter.all || t.parent_id.is_none(),
            };
            let repo = repo_of(t);
            scope_matches
                && (filter.status.is_empty() || filter.status.contains(&t.status))
                && filter
                    .assignee
                    .is_none_or(|a| t.assignee.as_deref() == Some(a))
                && (!filter.local || repo.is_none())
                && self.repo.as_ref().is_none_or(|r| repo.as_ref() == Some(r))
                && search.as_ref().is_none_or(|s| {
                    t.title.to_lowercase().contains(s) || t.description.to_lowercase().contains(s)
                })
        };
        Ok(tasks
            .iter()
            .filter(|t| matches(t))
            .take(filter.limit)
            .cloned()
            .collect())
    }
}

impl Cli {
    /// Publishes a local task as a GitHub issue in `repository` or the default repository.
    fn push(&self, store: &Store, id: i64, repository: Option<&str>) -> Result<Task> {
        let repo = repository
            .or(self.repo.as_deref())
            .context("no repository given; pass owner/name or set --repo / TASK_TOOL_REPO")?;
        Ok(github::push_task(store, &GhCli, id, repo)?)
    }
}

/// Approves or rejects work under review; `comment` may be `-` to read stdin.
fn review(
    store: &Store,
    actor: &Actor,
    id: i64,
    decision: ReviewDecision,
    comment: &str,
) -> Result<Value> {
    Ok(serde_json::to_value(store.review_task(
        id,
        actor,
        decision,
        &text(comment)?,
    )?)?)
}

/// Deletes a task and its descendants, returning what was deleted.
fn delete(store: &Store, id: i64) -> Result<Value> {
    let task = get(store, id)?;
    store.delete(id)?;
    Ok(json!({"deleted": task}))
}

/// Creates a task. A top-level task is worked on in the current folder unless `workdir`
/// says otherwise; a subtask inherits its parent's folder.
fn create(
    store: &Store,
    actor: Actor,
    title: &str,
    body: &str,
    parent: Option<i64>,
    workdir: Option<&std::path::Path>,
) -> Result<Task> {
    let workdir = match (workdir, parent) {
        (Some(dir), _) => Some(std::path::absolute(dir)?),
        (None, None) => Some(std::env::current_dir()?),
        (None, Some(_)) => None,
    };
    Ok(store.create(&NewTask {
        title: title.to_owned(),
        description: text(body)?,
        parent_id: parent,
        created_by: Some(actor),
        workdir: workdir.map(|p| p.display().to_string()),
        ..NewTask::default()
    })?)
}

fn get(store: &Store, id: i64) -> Result<Task> {
    store
        .get(id)?
        .with_context(|| format!("task {id} not found"))
}

fn text(value: &str) -> Result<String> {
    if value != "-" {
        return Ok(value.to_owned());
    }
    let mut value = String::new();
    io::stdin()
        .read_to_string(&mut value)
        .context("reading text from stdin")?;
    Ok(value)
}
