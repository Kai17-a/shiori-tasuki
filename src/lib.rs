//! Task manager that works with AI agents, GitHub issues, and a browser admin page.

pub mod activity;
pub mod git_evidence;
pub mod github;
pub mod mcp;
pub mod settings;
pub mod stats;
mod store;
pub mod sync;
mod task;
pub mod web;
pub mod work;

pub use store::{MAX_TITLE_CHARS, Scope, Store, StoreError};
pub use task::{
    GithubLink, NewSubtask, NewTask, ParseStatusError, Status, SubtaskSummary, Task, TaskUpdate,
};

/// Shared workflow for agents using MCP or the shell CLI.
pub const INSTRUCTIONS: &str = "This is the user's personal task list. Work on a task only when \
the user asks you to in a conversation; never start work automatically. Read the task with \
get_task (CLI: task-tool view ID); its history includes earlier notes and the user's \
rejection reasons, so read them before starting. Call start_task (CLI: task-tool start ID) \
and report progress with add_note (CLI: task-tool note ID MESSAGE). When you finish, report \
with complete_task (CLI: task-tool done ID --summary TEXT), summarizing what you did and how \
you verified it, and attach PR and artifact links (CLI: --link URL). Completion goes to the \
user for review; only the user approves it. If you cannot finish, call fail_task \
(CLI: task-tool fail ID --reason TEXT). Before starting, split work that has two or more \
steps the user could check on their own into 3-7 subtasks with create_subtasks \
(CLI: task-tool split ID TITLE...); do quick single-step work directly without subtasks. Use create_task (CLI: task-tool create TITLE --body TEXT) \
when the user asks to register something. GitHub-linked titles and descriptions must be edited on GitHub. Work in the task's workdir. \
Discover tasks with task-tool list --status todo --json id,title; inspect statistics with \
task-tool stats. Use --as codex or TASK_TOOL_ACTOR=codex for Codex; Claude Code is detected \
from CLAUDECODE=1. CLI text arguments accept - to read stdin. Use --json for structured output; \
optional comma-separated fields select top-level keys. Run task-tool --help for all commands.";
