use std::sync::Arc;

use serde_json::{Value, json};
use task_tool::github::{GhError, GhRunner};
use task_tool::mcp::McpServer;
use task_tool::{NewTask, Scope, Store};

struct NoGh;

impl GhRunner for NoGh {
    fn run(&self, _: &[String]) -> Result<String, GhError> {
        Err(GhError::Failed("gh is not available in tests".into()))
    }
}

fn server() -> (McpServer, Store) {
    let store = Store::open_in_memory().unwrap();
    let mut server = McpServer::new(store.clone(), Arc::new(NoGh), None);
    let init = server
        .handle(json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "claude-code", "version": "1"}}
        }))
        .expect("initialize gets a response");
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert!(
        server
            .handle(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .is_none(),
        "notifications get no response"
    );
    (server, store)
}

fn call(server: &mut McpServer, name: &str, arguments: Value) -> Value {
    let res = server
        .handle(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}))
        .unwrap();
    res["result"].clone()
}

fn payload(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[test]
fn lists_the_task_tools() {
    let (mut server, _) = server();
    let res = server
        .handle(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .unwrap();
    let names: Vec<&str> = res["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for expected in [
        "list_tasks",
        "get_task",
        "create_task",
        "create_subtasks",
        "update_task",
        "get_stats",
        "start_task",
        "add_note",
        "complete_task",
        "fail_task",
        "push_task_to_github",
    ] {
        assert!(
            names.contains(&expected),
            "{expected} missing from {names:?}"
        );
    }
    assert!(res["result"]["tools"][0]["inputSchema"]["type"] == "object");
}

#[test]
fn an_agent_splits_a_task_into_subtasks() {
    let (mut server, store) = server();
    let parent = store
        .create(NewTask {
            title: "Add login".into(),
            description: "OAuth via GitHub".into(),
            ..NewTask::default()
        })
        .unwrap();

    let detail = payload(&call(&mut server, "get_task", json!({"id": parent.id})));
    assert_eq!(detail["task"]["title"], "Add login");

    let result = call(
        &mut server,
        "create_subtasks",
        json!({"parent_id": parent.id, "subtasks": [
            {"title": "Register OAuth app", "description": "client id stored in env"},
            {"title": "Add callback route"}
        ]}),
    );
    assert_ne!(result["isError"], true, "{result}");
    let created = payload(&result);
    assert_eq!(created.as_array().unwrap().len(), 2);

    let children = store.list(Scope::ChildrenOf(parent.id)).unwrap();
    assert_eq!(children.len(), 2);
    assert!(
        children.iter().all(|c| c.created_by == "claude-code"),
        "subtasks are attributed to the MCP client"
    );
}

#[test]
fn tool_errors_are_reported_in_the_result_not_as_protocol_errors() {
    let (mut server, _) = server();
    let result = call(
        &mut server,
        "create_subtasks",
        json!({"parent_id": 404, "subtasks": [{"title": "x"}]}),
    );
    assert_eq!(result["isError"], true);
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not found")
    );

    let result = call(
        &mut server,
        "create_task",
        json!({"description": "no title"}),
    );
    assert_eq!(result["isError"], true, "{result}");
}

#[test]
fn creates_and_updates_tasks() {
    let (mut server, store) = server();
    let created = payload(&call(
        &mut server,
        "create_task",
        json!({"title": "Write tests"}),
    ));
    let id = created["id"].as_i64().unwrap();
    assert_eq!(created["created_by"], "claude-code");

    let updated = payload(&call(
        &mut server,
        "update_task",
        json!({"id": id, "status": "review"}),
    ));
    assert_eq!(updated["status"], "review");

    let listed = payload(&call(
        &mut server,
        "list_tasks",
        json!({"status": "review"}),
    ));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let listed = payload(&call(&mut server, "list_tasks", json!({"status": "todo"})));
    assert!(listed.as_array().unwrap().is_empty());
    assert_eq!(store.list(Scope::All).unwrap().len(), 1);
}

#[test]
fn offers_a_decompose_prompt() {
    let (mut server, store) = server();
    let task = store
        .create(NewTask {
            title: "Migrate DB".into(),
            ..NewTask::default()
        })
        .unwrap();
    let res = server
        .handle(json!({"jsonrpc": "2.0", "id": 3, "method": "prompts/get",
                       "params": {"name": "decompose_task", "arguments": {"task_id": task.id.to_string()}}}))
        .unwrap();
    let text = res["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(text.contains("Migrate DB"));
    assert!(text.contains("create_subtasks"));
}

#[test]
fn unknown_methods_and_bad_json_are_protocol_errors() {
    let (mut server, _) = server();
    let res = server
        .handle(json!({"jsonrpc": "2.0", "id": 9, "method": "nope"}))
        .unwrap();
    assert_eq!(res["error"]["code"], -32601);
    assert_eq!(res["id"], 9);

    let res = server.handle_line("{not json").unwrap();
    assert_eq!(res["error"]["code"], -32700);
}

#[test]
fn an_agent_reports_its_work_through_the_task_history() {
    let (mut server, store) = server();
    let task = store
        .create(NewTask {
            title: "Fix flaky test".into(),
            ..NewTask::default()
        })
        .unwrap();

    let started = payload(&call(&mut server, "start_task", json!({"id": task.id})));
    assert_eq!(started["status"], "in_progress");
    assert_eq!(started["assignee"], "claude-code");

    let note = call(
        &mut server,
        "add_note",
        json!({"id": task.id, "message": "Reproduced: race in setup"}),
    );
    assert_ne!(note["isError"], true, "{note}");

    let mine = payload(&call(&mut server, "list_tasks", json!({"assignee": "me"})));
    assert_eq!(mine.as_array().unwrap().len(), 1);

    let finished = payload(&call(
        &mut server,
        "complete_task",
        json!({"id": task.id, "summary": "Added a lock; 50 runs green"}),
    ));
    assert_eq!(finished["status"], "review");

    let history = store.events_for(task.id, 10).unwrap();
    assert!(
        history
            .iter()
            .all(|e| e.actor == "claude-code" || e.actor == "user")
    );
    assert!(
        history
            .iter()
            .any(|e| e.message == "Reproduced: race in setup")
    );
}

#[test]
fn get_task_includes_why_earlier_runs_failed() {
    let (mut server, store) = server();
    let task = store
        .create(NewTask {
            title: "Docs".into(),
            ..NewTask::default()
        })
        .unwrap();
    store
        .fail_task(task.id, "claude-code", "The docs folder is missing")
        .unwrap();

    let detail = payload(&call(&mut server, "get_task", json!({"id": task.id})));

    assert_eq!(detail["task"]["status"], "todo");
    let history = detail["history"].as_array().unwrap();
    assert!(
        history
            .iter()
            .any(|e| e["message"] == "The docs folder is missing")
    );
}

#[test]
fn tasks_registered_by_an_agent_run_in_its_folder() {
    let (mut server, _) = server();
    let created = payload(&call(&mut server, "create_task", json!({"title": "Do X"})));
    let cwd = std::env::current_dir().unwrap().display().to_string();
    assert_eq!(created["workdir"], cwd);

    let explicit = payload(&call(
        &mut server,
        "create_task",
        json!({"title": "Do Y", "workdir": "/srv/app"}),
    ));
    assert_eq!(explicit["workdir"], "/srv/app");
}

#[test]
fn updates_from_an_agent_are_attributed_to_it() {
    let (mut server, store) = server();
    let task = store
        .create(NewTask {
            title: "T".into(),
            ..NewTask::default()
        })
        .unwrap();
    call(
        &mut server,
        "update_task",
        json!({"id": task.id, "status": "in_progress"}),
    );
    assert_eq!(
        store.events_for(task.id, 1).unwrap()[0].actor,
        "claude-code"
    );
}

#[test]
fn agent_cannot_mark_done_via_update() {
    let (mut server, store) = server();
    let task = store
        .create(NewTask {
            title: "Review required".into(),
            ..NewTask::default()
        })
        .unwrap();
    let response = call(
        &mut server,
        "update_task",
        json!({"id": task.id, "status": "done"}),
    );
    assert_eq!(response["isError"], true);
    assert!(
        response["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("complete_task")
    );
    assert_eq!(
        store.get(task.id).unwrap().unwrap().status,
        task_tool::Status::Todo
    );
}

#[test]
fn external_content_update_is_a_tool_error() {
    let (mut server, store) = server();
    let task = store
        .create(NewTask {
            title: "Issue".into(),
            ..Default::default()
        })
        .unwrap();
    store
        .link_github(
            task.id,
            &task_tool::GithubLink {
                repo: "o/r".into(),
                number: 1,
                url: "https://github.com/o/r/issues/1".into(),
            },
        )
        .unwrap();
    for fields in [
        json!({"id":task.id,"title":"Changed"}),
        json!({"id":task.id,"description":"Changed"}),
    ] {
        let result = call(&mut server, "update_task", fields);
        assert_eq!(result["isError"], true);
        assert!(
            result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("GitHub")
        );
    }
    let result = call(
        &mut server,
        "update_task",
        json!({"id":task.id,"title":"Issue","description":"","status":"in_progress"}),
    );
    assert_ne!(result["isError"], true);
}
