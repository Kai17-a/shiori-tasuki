//! Model Context Protocol server over stdio, so AI agents can read and split tasks.
//!
//! Messages are newline-delimited JSON-RPC 2.0, as the MCP stdio transport requires.

use std::fmt::Write as _;
use std::io::{self, BufRead, Write};
use std::sync::Arc;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::Actor;
use crate::github::{self, GhRunner};
use crate::store::{Scope, Store, StoreError};
use crate::task::{NewSubtask, NewTask, Status, Task, TaskUpdate};

/// Protocol revisions this server can speak, newest first.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

use crate::INSTRUCTIONS;

/// Tasks `list_tasks` returns unless the agent asks for another page size; every task
/// carries its description, so an unbounded list would fill the agent's context.
const LIST_DEFAULT_LIMIT: usize = 50;

/// Largest page `list_tasks` returns.
const LIST_MAX_LIMIT: usize = 200;

/// History entries returned with `get_task`, newest first.
const TASK_HISTORY_LIMIT: u32 = 20;

/// Builds the instructions an agent follows to split `task` into subtasks.
pub fn decompose_prompt(task: &Task, subtasks: &[Task]) -> String {
    let mut text = format!(
        "shiori-tasuki のタスク #{} 「{}」を、実行できる粒度の子タスクに分解してください。\n",
        task.id, task.title
    );
    if !task.description.is_empty() {
        let _ = write!(text, "\n説明:\n{}\n", task.description);
    }
    if !subtasks.is_empty() {
        text.push_str("\n登録済みの子タスク:\n");
        for sub in subtasks {
            let _ = writeln!(text, "- #{} {} ({})", sub.id, sub.title, sub.status);
        }
    }
    let _ = write!(
        text,
        "\n手順:\n\
         1. shiori-tasuki の MCP ツール get_task（id: {id}）で内容と既存の子タスクを確認する。\n\
         2. 必要ならリポジトリやコードを調べ、足りない作業を洗い出す。\n\
         3. 登録済みと重複しない子タスクだけを create_subtasks（parent_id: {id}）で一度に登録する。\n\
         各子タスクは1つの成果物か確認できる作業にし、短いタイトルと、完了条件を含む説明を付けてください。\n",
        id = task.id
    );
    text
}

/// Stateful MCP session: remembers the client name to attribute created tasks.
pub struct McpServer {
    store: Store,
    gh: Arc<dyn GhRunner + Send + Sync>,
    default_repo: Option<String>,
    /// The connected agent, named by the client; never the person or the GitHub sync.
    actor: Actor,
    /// Folder the agent runs in; new top-level tasks are worked on there.
    workdir: Option<String>,
    /// T3 Code thread that started this server, recorded on each work session.
    thread_id: Option<String>,
}

/// JSON-RPC error codes from the specification.
mod code {
    pub(super) const PARSE_ERROR: i64 = -32700;
    pub(super) const INVALID_REQUEST: i64 = -32600;
    pub(super) const METHOD_NOT_FOUND: i64 = -32601;
    pub(super) const INVALID_PARAMS: i64 = -32602;
}

struct RpcError(i64, String);

impl std::fmt::Debug for McpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The gh runner is a trait object without Debug.
        f.debug_struct("McpServer")
            .field("actor", &self.actor)
            .field("default_repo", &self.default_repo)
            .field("workdir", &self.workdir)
            .field("thread_id", &self.thread_id)
            .finish_non_exhaustive()
    }
}

impl McpServer {
    pub fn new(
        store: Store,
        gh: Arc<dyn GhRunner + Send + Sync>,
        default_repo: Option<String>,
    ) -> Self {
        Self {
            store,
            gh,
            default_repo,
            actor: Actor::Agent("ai-agent".into()),
            // Agents start MCP servers in their project folder.
            workdir: std::env::current_dir()
                .ok()
                .map(|d| d.display().to_string()),
            thread_id: std::env::var("T3CODE_THREAD_ID").ok(),
        }
    }

    /// Reads requests from stdin and writes responses to stdout until stdin closes.
    ///
    /// # Errors
    ///
    /// Fails when stdin or stdout fails.
    pub fn serve_stdio(mut self) -> io::Result<()> {
        let stdin = io::stdin().lock();
        let mut stdout = io::stdout().lock();
        for line in stdin.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            if let Some(response) = self.handle_line(&line) {
                serde_json::to_writer(&mut stdout, &response)?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
        }
        Ok(())
    }

    /// Handles one raw line; returns `None` for notifications.
    pub fn handle_line(&mut self, line: &str) -> Option<Value> {
        match serde_json::from_str::<Value>(line) {
            Ok(message) => self.handle(&message),
            Err(e) => Some(error_response(
                &Value::Null,
                code::PARSE_ERROR,
                &e.to_string(),
            )),
        }
    }

    /// Handles one JSON-RPC message; returns `None` for notifications.
    pub fn handle(&mut self, message: &Value) -> Option<Value> {
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str);
        let (Some(id), Some(method)) = (id, method) else {
            // Notifications and stray responses need no reply; a message with an id but
            // no method is malformed.
            return message
                .get("id")
                .map(|id| error_response(id, code::INVALID_REQUEST, "missing method"));
        };
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let response = match self.dispatch(method, params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(RpcError(code, msg)) => error_response(&id, code, &msg),
        };
        Some(response)
    }

    fn dispatch(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => {
                let call: ToolCall = parse(params)?;
                Ok(self.call_tool(&call.name, call.arguments))
            }
            "prompts/list" => Ok(json!({ "prompts": [{
                "name": "decompose_task",
                "description": "Split a task into concrete subtasks with create_subtasks",
                "arguments": [{ "name": "task_id", "description": "Id of the task to split", "required": true }]
            }]})),
            "prompts/get" => self.prompt(params),
            _ => Err(RpcError(
                code::METHOD_NOT_FOUND,
                format!("unknown method {method}"),
            )),
        }
    }

    fn initialize(&mut self, params: &Value) -> Value {
        // Actor::agent refuses "user" and "github", which carry the person's rights (only
        // the person approves work), so a client cannot take them by naming itself that way.
        if let Some(actor) = params
            .pointer("/clientInfo/name")
            .and_then(Value::as_str)
            .and_then(Actor::agent)
        {
            self.actor = actor;
        }
        let requested = params.get("protocolVersion").and_then(Value::as_str);
        let version = requested
            .filter(|v| PROTOCOL_VERSIONS.contains(v))
            .unwrap_or(PROTOCOL_VERSIONS[0]);
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": {}, "prompts": {} },
            "serverInfo": { "name": "shiori-tasuki", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })
    }

    fn prompt(&self, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        struct Args {
            task_id: String,
        }
        #[derive(Deserialize)]
        struct PromptGet {
            name: String,
            arguments: Args,
        }
        let get: PromptGet = parse(params)?;
        if get.name != "decompose_task" {
            return Err(RpcError(
                code::INVALID_PARAMS,
                format!("unknown prompt {}", get.name),
            ));
        }
        let id: i64 = get
            .arguments
            .task_id
            .trim()
            .parse()
            .map_err(|_| RpcError(code::INVALID_PARAMS, "task_id must be a number".into()))?;
        let invalid = |e: StoreError| RpcError(code::INVALID_PARAMS, e.to_string());
        let task = self.store.get(id).map_err(invalid)?.ok_or(RpcError(
            code::INVALID_PARAMS,
            format!("task {id} not found"),
        ))?;
        let subtasks = self.store.list(Scope::ChildrenOf(id)).map_err(invalid)?;
        Ok(json!({
            "description": format!("Split task #{id} into subtasks"),
            "messages": [{ "role": "user", "content": { "type": "text", "text": decompose_prompt(&task, &subtasks) } }]
        }))
    }

    /// Runs a tool; failures become `isError` results the model can read and correct.
    fn call_tool(&self, name: &str, args: Value) -> Value {
        match self.run_tool(name, args) {
            Ok(value) => json!({
                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }]
            }),
            Err(msg) => json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
        }
    }

    fn run_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        match name {
            "list_tasks" | "get_task" | "get_stats" => self.read_tool(name, args),
            "start_task" | "add_note" | "complete_task" | "fail_task" | "record_user_review" => {
                self.work_tool(name, args)
            }
            _ => self.edit_tool(name, args),
        }
    }

    /// Tools that only read: listing, one task, statistics.
    fn read_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        let store = &self.store;
        match name {
            "list_tasks" => {
                #[derive(Deserialize)]
                struct A {
                    parent_id: Option<i64>,
                    status: Option<Status>,
                    assignee: Option<String>,
                    limit: Option<usize>,
                }
                let a: A = args_of(args)?;
                let limit = a.limit.unwrap_or(LIST_DEFAULT_LIMIT);
                if !(1..=LIST_MAX_LIMIT).contains(&limit) {
                    return Err(format!("limit must be 1-{LIST_MAX_LIMIT}, got {limit}"));
                }
                // "me" is the calling agent; an assignee filter searches subtasks too.
                let assignee = a.assignee.map(|n| {
                    if n == "me" {
                        self.actor.as_str().to_owned()
                    } else {
                        n
                    }
                });
                let scope = match (a.parent_id, &assignee) {
                    (Some(id), _) => Scope::ChildrenOf(id),
                    (None, Some(_)) => Scope::All,
                    (None, None) => Scope::TopLevel,
                };
                let tasks: Vec<Task> = store
                    .list(scope)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    // Hidden tasks are the person's way of putting work aside.
                    .filter(|t| t.hidden_at.is_none())
                    .filter(|t| a.status.is_none_or(|s| t.status == s))
                    .filter(|t| assignee.is_none() || t.assignee == assignee)
                    .take(limit)
                    .collect();
                to_json(&tasks)
            }
            "get_task" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                }
                let a: A = args_of(args)?;
                let task = store
                    .get(a.id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("task {} not found", a.id))?;
                let subtasks = store
                    .list(Scope::ChildrenOf(a.id))
                    .map_err(|e| e.to_string())?;
                let history = store
                    .events_for(a.id, TASK_HISTORY_LIMIT)
                    .map_err(|e| e.to_string())?;
                Ok(
                    json!({ "task": task, "subtasks": subtasks, "history": history, "sessions": store.sessions(a.id).map_err(|e| e.to_string())? }),
                )
            }
            "get_stats" => to_json(&store.stats().map_err(|e| e.to_string())?),
            _ => Err(format!("unknown tool {name}")),
        }
    }

    /// Tools that record the agent's work on a task: start, notes, report, failure.
    fn work_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        let store = &self.store;
        match name {
            "start_task" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                }
                let a: A = args_of(args)?;
                to_json(
                    &store
                        .start_task(a.id, &self.actor, self.thread_id.as_deref())
                        .map_err(|e| e.to_string())?,
                )
            }
            "add_note" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                    message: String,
                }
                let a: A = args_of(args)?;
                to_json(
                    &store
                        .add_note(a.id, &self.actor, &a.message)
                        .map_err(|e| e.to_string())?,
                )
            }
            "complete_task" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                    summary: String,
                    #[serde(default)]
                    links: Vec<crate::work::WorkLink>,
                }
                let a: A = args_of(args)?;
                to_json(
                    &store
                        .complete_with_links(a.id, &self.actor, &a.summary, &a.links)
                        .map_err(|e| e.to_string())?,
                )
            }
            "fail_task" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                    reason: String,
                }
                let a: A = args_of(args)?;
                to_json(
                    &store
                        .fail_task(a.id, &self.actor, &a.reason)
                        .map_err(|e| e.to_string())?,
                )
            }
            "record_user_review" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                    decision: crate::ReviewDecision,
                    user_said: String,
                }
                let a: A = args_of(args)?;
                to_json(
                    &store
                        .review_for_user(a.id, &self.actor, a.decision, &a.user_said)
                        .map_err(|e| e.to_string())?,
                )
            }
            _ => Err(format!("unknown tool {name}")),
        }
    }

    /// Tools that add or change tasks, or publish one to GitHub.
    fn edit_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        let store = &self.store;
        match name {
            "create_task" => {
                #[derive(Deserialize)]
                struct A {
                    title: String,
                    #[serde(default)]
                    description: String,
                    parent_id: Option<i64>,
                    workdir: Option<String>,
                }
                let a: A = args_of(args)?;
                // Subtasks inherit their parent's folder; new top-level tasks use ours.
                let workdir = a.workdir.or_else(|| {
                    a.parent_id
                        .is_none()
                        .then(|| self.workdir.clone())
                        .flatten()
                });
                let task = store
                    .create(&NewTask {
                        title: a.title,
                        description: a.description,
                        parent_id: a.parent_id,
                        status: None,
                        created_by: Some(self.actor.clone()),
                        workdir,
                    })
                    .map_err(|e| e.to_string())?;
                to_json(&task)
            }
            "create_subtasks" => {
                #[derive(Deserialize)]
                struct A {
                    parent_id: i64,
                    subtasks: Vec<NewSubtask>,
                }
                let a: A = args_of(args)?;
                let tasks = store
                    .create_subtasks(a.parent_id, &a.subtasks, &self.actor)
                    .map_err(|e| e.to_string())?;
                to_json(&tasks)
            }
            "update_task" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                    #[serde(flatten)]
                    update: TaskUpdate,
                }
                let a: A = args_of(args)?;
                let task = store
                    .update_as(a.id, &a.update, &self.actor)
                    .map_err(|e| e.to_string())?;
                to_json(&task)
            }
            "push_task_to_github" => {
                #[derive(Deserialize)]
                struct A {
                    id: i64,
                    repo: Option<String>,
                }
                let a: A = args_of(args)?;
                let repo = self.repo(a.repo)?;
                let task = github::push_task(store, self.gh.as_ref(), a.id, &repo, &self.actor)
                    .map_err(|e| e.to_string())?;
                to_json(&task)
            }
            _ => Err(format!("unknown tool {name}")),
        }
    }

    fn repo(&self, requested: Option<String>) -> Result<String, String> {
        requested
            .or_else(|| self.default_repo.clone())
            .ok_or_else(|| "repo is required (no default repository configured)".into())
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct ToolCall {
    name: String,
    #[serde(default)]
    arguments: Value,
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|e| RpcError(code::INVALID_PARAMS, e.to_string()))
}

fn args_of<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_definitions() -> Value {
    let status = json!({ "type": "string", "enum": Status::ALL.map(Status::as_str) });
    let subtask = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "Short imperative title, at most 200 characters" },
            "description": { "type": "string", "description": "What to do and how to tell it is done" }
        },
        "required": ["title"]
    });
    json!([
        {
            "name": "list_tasks",
            "description": "List top-level tasks, or the subtasks of parent_id. Filter by status, or by assignee (\"me\" for your own tasks, searching subtasks too). Each task includes subtask counts, assignee and last activity time. Returns the oldest matching tasks first, at most limit (default 50); narrow with status rather than reading everything.",
            "inputSchema": { "type": "object", "properties": {
                "parent_id": { "type": "integer" }, "status": status,
                "assignee": { "type": "string", "description": "Agent or person name, or \"me\"" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Most tasks to return; default 50" }
            }}
        },
        {
            "name": "get_task",
            "description": "Get one task with its direct subtasks and its recent history (newest first), including the person's comments and review feedback.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] }
        },
        {
            "name": "create_task",
            "description": "Register a task when the user asks. This does not execute it. Uses this session's folder unless workdir is given (subtasks inherit their parent's).",
            "inputSchema": { "type": "object", "properties": {
                "title": { "type": "string" }, "description": { "type": "string", "description": "What done looks like" },
                "parent_id": { "type": "integer" }, "workdir": { "type": "string", "description": "Absolute folder to work in" }
            }, "required": ["title"] }
        },
        {
            "name": "create_subtasks",
            "description": "Split a task: add several child tasks to parent_id at once (all or nothing). Read the task with get_task first and do not duplicate existing subtasks.",
            "inputSchema": { "type": "object", "properties": {
                "parent_id": { "type": "integer" },
                "subtasks": { "type": "array", "items": subtask, "minItems": 1 }
            }, "required": ["parent_id", "subtasks"] }
        },
        {
            "name": "update_task",
            "description": "Change task fields. GitHub-linked titles and descriptions must be edited on GitHub; status changes remain allowed.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" }, "title": { "type": "string" },
                "description": { "type": "string" }, "status": status
            }, "required": ["id"] }
        },
        {
            "name": "start_task",
            "description": "Begin working on a task: sets it in progress and assigns it to you, so the person sees who is on it.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] }
        },
        {
            "name": "add_note",
            "description": "Report progress, a finding or a blocker on a task. Keep notes short and factual; they appear in the person's activity feed.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" },
                "message": { "type": "string", "description": "At most 4000 characters" }
            }, "required": ["id", "message"] }
        },
        {
            "name": "complete_task",
            "description": "Report work for user review. Include what changed, verification, and artifact links. Only the user approves it, in the dashboard or by telling you (then use record_user_review).",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" },
                "summary": { "type": "string" },
                "links": { "type": "array", "items": { "type": "object", "properties": { "url": { "type": "string" }, "label": { "type": "string" } }, "required": ["url"] } }
            }, "required": ["id", "summary"] }
        },
        {
            "name": "fail_task",
            "description": "Report why a task could not be finished: records the reason, returns it to todo and clears the assignee. Work resumes only when the user asks.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" },
                "reason": { "type": "string" }
            }, "required": ["id", "reason"] }
        },
        {
            "name": "record_user_review",
            "description": "Record the approval or change request the user gave you in this conversation for a task under review, so the user need not repeat it in the dashboard. Call it only when the user said so; never on your own judgment. After a reject, the task returns to todo: start it again and make the requested changes.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" },
                "decision": { "type": "string", "enum": ["approve", "reject"] },
                "user_said": { "type": "string", "description": "The user's words, quoted; for a reject, what to change" }
            }, "required": ["id", "decision", "user_said"] }
        },
        {
            "name": "get_stats",
            "description": "Dashboard summary: counts per status, daily created/completed, per repository and per creator, recent updates, and unfinished tasks with subtasks.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "push_task_to_github",
            "description": "Create a GitHub issue assigned to me in repo (owner/name) from a local task (subtasks become a checklist) and link them.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" }, "repo": { "type": "string" }
            }, "required": ["id"] }
        }
    ])
}
