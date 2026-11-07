use std::io::Write;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};
use tempfile::TempDir;

struct Cli(TempDir);
impl Cli {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("temporary folder is created"))
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_task-manager"));
        c.current_dir(self.0.path());
        c.env_remove("CLAUDECODE")
            .env_remove("TASK_MANAGER_ACTOR")
            .env_remove("TASK_MANAGER_REPO");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("CODEX_")
                || key.to_string_lossy().starts_with("CLAUDE_")
            {
                c.env_remove(key);
            }
        }
        c.env("TASK_MANAGER_DB", self.0.path().join("tasks.db"))
            .env("HOME", self.0.path())
            .env("XDG_DATA_HOME", self.0.path().join("data"));
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command()
            .args(args)
            .output()
            .expect("task-manager runs")
    }
    fn json(&self, args: &[&str]) -> Value {
        let o = self.run(args);
        assert!(
            o.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        serde_json::from_slice(&o.stdout).expect("task-manager prints JSON")
    }
}

#[test]
fn lifecycle_and_attribution() {
    let c = Cli::new();
    let parent = c.json(&["create", "Project", "--body", "Details", "--json"]);
    assert_eq!(parent["created_by"], "user");
    let children = c.json(&[
        "--as",
        "codex",
        "split",
        "1",
        "Implement",
        "Verify",
        "--json",
    ]);
    assert_eq!(children[0]["workdir"], parent["workdir"]);
    assert_eq!(children[0]["created_by"], "codex");
    let started = c.json(&["--as", "codex", "start", "2", "--json"]);
    assert_eq!(started["assignee"], "codex");
    assert_eq!(started["status"], "in_progress");
    c.json(&[
        "--as",
        "codex",
        "edit",
        "2",
        "--title",
        "Implementation",
        "--body",
        "Changed",
        "--json",
    ]);
    let failed = c.json(&[
        "--as", "codex", "fail", "2", "--reason", "Blocked", "--json",
    ]);
    assert_eq!(failed["status"], "todo");
    assert!(failed["assignee"].is_null());
    c.json(&[
        "--as",
        "codex",
        "done",
        "2",
        "--summary",
        "Tested",
        "--json",
    ]);
    assert_eq!(c.json(&["view", "1", "--json"])["task"]["status"], "todo");
    c.json(&[
        "--as",
        "codex",
        "done",
        "3",
        "--summary",
        "Passed",
        "--json",
    ]);
    c.json(&["approve", "2", "--json"]);
    c.json(&["approve", "3", "--json"]);
    let view = c.json(&["view", "1", "--history", "2", "--json"]);
    assert_eq!(view["task"]["status"], "done");
    assert_eq!(view["subtasks"].as_array().unwrap().len(), 2);
    assert_eq!(view["history"].as_array().unwrap().len(), 2);
    assert_eq!(view["history"][0]["actor"], "user");
    let events = c.json(&["activity", "--task", "2", "--json"]);
    assert!(
        events
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["actor"] == "codex" || e["actor"] == "user")
    );
    assert_eq!(c.json(&["stats", "--json", "total"]), json!({"total":3}));
    let hidden = c.json(&["hide", "1", "--json", "hidden_at"]);
    assert!(hidden["hidden_at"].is_string(), "{hidden}");
    assert_eq!(c.json(&["list", "--all", "--json"]), json!([]));
    assert_eq!(
        c.json(&["list", "--all", "--hidden", "--json", "id"])
            .as_array()
            .map(Vec::len),
        Some(3)
    );
    c.json(&["unhide", "1", "--json"]);
    assert_eq!(
        c.json(&["list", "--all", "--json", "id"])
            .as_array()
            .map(Vec::len),
        Some(3)
    );
}

#[test]
fn filters_json_tsv_and_errors() {
    let c = Cli::new();
    c.json(&["create", "Alpha", "--body", "Needle", "--json"]);
    c.json(&["create", "Beta", "--parent", "1", "--json"]);
    c.json(&[
        "edit",
        "2",
        "--assignee",
        "codex",
        "--status",
        "review",
        "--json",
    ]);
    assert_eq!(
        c.json(&[
            "list", "--all", "--status", "todo", "--status", "review", "--json", "id"
        ])
        .as_array()
        .unwrap()
        .len(),
        2
    );
    assert_eq!(
        c.json(&["list", "--parent", "1", "--json", "id,title,status"]),
        json!([{"id":2,"title":"Beta","status":"review"}])
    );
    assert_eq!(
        c.json(&["list", "--all", "--assignee", "codex", "--json", "id"]),
        json!([{"id":2}])
    );
    assert_eq!(
        c.json(&["list", "--search", "needle", "--local", "--json", "id"]),
        json!([{"id":1}])
    );
    assert_eq!(
        c.json(&["list", "--all", "--limit", "1", "--json", "id"]),
        json!([{"id":1}])
    );
    assert_eq!(c.json(&["list", "--repo", "a/b", "--json"]), json!([]));
    let tsv = c.run(&["list"]);
    assert_eq!(String::from_utf8(tsv.stdout).unwrap(), "1\ttodo\tAlpha\t\n");
    for args in [
        &["view", "999"][..],
        &["create", ""][..],
        &["list", "--json", "bogus"][..],
    ] {
        let o = c.run(args);
        assert_eq!(o.status.code(), Some(1));
        assert!(o.stdout.is_empty());
        let error = String::from_utf8_lossy(&o.stderr);
        assert!(!error.is_empty());
        if args[0] == "view" {
            assert!(error.contains("999"));
        }
        if args.contains(&"bogus") {
            assert!(error.contains("valid fields") && error.contains("title"));
        }
    }
    let o = c.run(&["create", "Should not be created", "--json", "bogus"]);
    assert!(!o.status.success());
    assert_eq!(
        c.json(&["list", "--all", "--json"])
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!c.run(&["create", &"x".repeat(201)]).status.success());
}

#[test]
fn stdin_aliases_and_agent_environment() {
    let c = Cli::new();
    let o = c
        .command()
        .env("CLAUDECODE", "1")
        .args(["add", "Task", "-d", "body", "--json"])
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["created_by"],
        "claude-code"
    );
    let o = c
        .command()
        .env("CLAUDECODE", "1")
        .env("TASK_MANAGER_ACTOR", "env-actor")
        .args(["--as", "explicit", "start", "1", "--json"])
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["assignee"],
        "explicit"
    );
    let o = c
        .command()
        .env("TASK_MANAGER_ACTOR", "env-actor")
        .args(["start", "1", "--json"])
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["assignee"],
        "env-actor"
    );
    for args in [
        &["comment", "1", "-", "--json"][..],
        &["update", "1", "--body", "-", "--json"][..],
        &["done", "1", "--summary", "-", "--json"][..],
        &["fail", "1", "--reason", "-", "--json"][..],
    ] {
        let mut child = c
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"First line\nSecond line\n")
            .unwrap();
        let o = child.wait_with_output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    }
    let view = c.json(&["show", "1", "--json"]);
    assert_eq!(view["task"]["description"], "First line\nSecond line");
    assert!(
        view["history"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["message"] == "First line\nSecond line")
    );
    assert!(c.run(&["hide", "1"]).status.success());
    assert!(
        !c.run(&["rm", "1", "--yes"]).status.success(),
        "tasks can no longer be deleted"
    );
}

#[test]
fn database_resolution() {
    let c = Cli::new();
    let o = c
        .command()
        .env_remove("TASK_MANAGER_DB")
        .args(["list", "--json"])
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(c.0.path().join("data/task-manager/tasks.db").is_file());
    let other = c.0.path().join("other-folder");
    std::fs::create_dir(&other).unwrap();
    let o = c
        .command()
        .env_remove("TASK_MANAGER_DB")
        .current_dir(&other)
        .args(["create", "Shared DB", "--json"])
        .output()
        .unwrap();
    assert!(o.status.success());
    let o = c
        .command()
        .env_remove("TASK_MANAGER_DB")
        .args(["list", "--json", "title"])
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap(),
        json!([{"title":"Shared DB"}])
    );
    assert!(!other.join(".task-tool/tasks.db").exists());

    let o = c
        .command()
        .env_remove("TASK_MANAGER_DB")
        .env_remove("XDG_DATA_HOME")
        .args(["list"])
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(
        c.0.path()
            .join(".local/share/task-manager/tasks.db")
            .is_file()
    );
    let explicit = c.0.path().join("explicit/tasks.db");
    assert!(
        c.command()
            .arg("--db")
            .arg(&explicit)
            .arg("list")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(explicit.is_file());
    assert!(!c.0.path().join("tasks.db").exists());
}

#[test]
fn a_database_under_the_former_name_stays_in_use_until_a_new_one_exists() {
    let c = Cli::new();
    let data = c.0.path().join("data");
    let legacy = data.join("task-tool/tasks.db");
    let in_folder = |path: &std::path::Path, title: &str| {
        let o = c
            .command()
            .env_remove("TASK_MANAGER_DB")
            .args(["create", title])
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert!(path.is_file());
    };
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    assert!(
        c.command()
            .arg("--db")
            .arg(&legacy)
            .args(["create", "Old"])
            .output()
            .unwrap()
            .status
            .success()
    );
    in_folder(&legacy, "Still old");
    assert!(!data.join("task-manager/tasks.db").exists());

    std::fs::create_dir_all(data.join("task-manager")).unwrap();
    let current = data.join("task-manager/tasks.db");
    assert!(
        c.command()
            .arg("--db")
            .arg(&current)
            .args(["create", "New"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let o = c
        .command()
        .env_remove("TASK_MANAGER_DB")
        .args(["list", "--json", "title"])
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap(),
        json!([{"title":"New"}])
    );
}

#[test]
fn github_family_filters_and_edit_restriction() {
    use task_manager::{GithubLink, Store};
    let c = Cli::new();
    c.json(&["create", "Issue", "--json"]);
    c.json(&["split", "1", "Child", "--json"]);
    c.json(&["split", "2", "Grandchild", "--json"]);
    c.json(&["create", "Local", "--json"]);
    let store = Store::open(&c.0.path().join("tasks.db")).unwrap();
    store
        .link_github(
            1,
            &GithubLink {
                repo: "owner/repo".into(),
                number: 12,
                url: "https://github.com/owner/repo/issues/12".into(),
            },
        )
        .unwrap();
    assert_eq!(
        c.json(&["list", "--all", "--local", "--json", "id"]),
        json!([{"id":4}])
    );
    assert_eq!(
        c.json(&["list", "--all", "--repo", "owner/repo", "--json", "id"]),
        json!([{"id":1},{"id":2},{"id":3}])
    );
    let o = c.run(&[
        "edit",
        "1",
        "--title",
        "Edited issue",
        "--body",
        "Local edit",
        "--json",
    ]);
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stderr).contains("GitHub"));
    let o = c.run(&["edit", "1", "--status", "review", "--json"]);
    assert!(o.status.success());
    assert!(o.stderr.is_empty());
}

#[test]
fn stdin_create_workdir_and_clear_assignee() {
    let c = Cli::new();
    let mut child = c
        .command()
        .args([
            "create",
            "From stdin",
            "--body",
            "-",
            "--workdir",
            "project",
            "--json",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"Detailed\nbody\n")
        .unwrap();
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success());
    let task: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(task["description"], "Detailed\nbody");
    assert_eq!(
        task["workdir"],
        c.0.path().join("project").to_str().unwrap()
    );
    c.json(&["start", "1", "--json"]);
    let cleared = c.json(&["edit", "1", "--assignee", "", "--json"]);
    assert!(cleared["assignee"].is_null());
    let history = c.json(&["activity", "--json"]);
    assert!(
        history
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["actor"] == "user")
    );
    assert_eq!(
        c.json(&["view", "1", "--json", "history"])
            .as_object()
            .unwrap()
            .len(),
        1
    );
    let o = c.run(&["note", "1", "a\tb\nc\\d"]);
    assert!(o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).contains("a\\tb\\nc\\\\d"));
}

#[test]
fn help_guide_and_parse_errors_need_no_database() {
    let c = Cli::new();
    let help = c.run(&["--help"]);
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    for name in [
        "create",
        "add",
        "show",
        "update",
        "comment",
        "hide",
        "unhide",
        "XDG_DATA_HOME",
        "TASK_MANAGER_ACTOR",
    ] {
        assert!(text.contains(name), "missing {name} in {text}");
    }
    let guide = c.json(&["guide", "--json", "instructions"]);
    assert_eq!(guide["instructions"], task_manager::INSTRUCTIONS);
    let missing = c.run(&["done", "1"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("--summary"));
    assert!(!c.0.path().join("tasks.db").exists());
}

#[test]
fn github_push_accepts_positional_and_global_repo() {
    let c = Cli::new();
    for args in [
        &["gh", "push", "999", "owner/repo"][..],
        &["gh", "push", "999", "--repo", "owner/repo"][..],
        &["--repo", "owner/repo", "gh", "push", "999"][..],
    ] {
        let o = c.run(args);
        assert_eq!(o.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&o.stderr).contains("task 999 not found"),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }
}

#[test]
fn agents_cannot_bypass_review_and_thread_id_is_captured() {
    let c = Cli::new();
    c.json(&["create", "Task", "--json"]);
    let o = c
        .command()
        .env("T3CODE_THREAD_ID", "test-thread-123")
        .args(["--as", "codex", "start", "1", "--json"])
        .output()
        .unwrap();
    assert!(o.status.success());
    let o = c.run(&["--as", "codex", "edit", "1", "--status", "done"]);
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stderr).contains("complete_task"));
    // An agent records a review only with the user's words.
    let o = c.run(&["--as", "codex", "approve", "1"]);
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stderr).contains("what the user said"));
    c.json(&[
        "--as",
        "codex",
        "done",
        "1",
        "--summary",
        "Verified",
        "--link",
        "https://example.com/pr/1",
        "--json",
    ]);
    let v = c.json(&["view", "1", "--json"]);
    assert_eq!(v["task"]["status"], "review");
    assert_eq!(v["sessions"][0]["thread_id"], "test-thread-123");
    assert_eq!(v["sessions"][0]["outcome"], "reported");
    c.json(&["reject", "1", "--reason", "Need tests", "--json"]);
    c.json(&["--as", "codex", "start", "1", "--json"]);
    c.json(&[
        "--as",
        "codex",
        "done",
        "1",
        "--summary",
        "Retested",
        "--json",
    ]);
    c.json(&["approve", "1", "--comment", "Checked", "--json"]);
    assert_eq!(c.json(&["view", "1", "--json"])["task"]["status"], "done");
}

#[test]
fn an_agent_records_the_review_the_user_gave_in_the_conversation() {
    let c = Cli::new();
    c.json(&["create", "Task", "--json"]);
    c.json(&["--as", "codex", "start", "1", "--json"]);
    c.json(&["--as", "codex", "done", "1", "--summary", "Done", "--json"]);
    let o = c.run(&["--as", "codex", "approve", "2", "--comment", "OK"]);
    assert!(!o.status.success(), "an unknown task is refused");

    c.json(&[
        "--as",
        "codex",
        "reject",
        "1",
        "--reason",
        "ボタンの色を変えて",
        "--json",
    ]);
    let v = c.json(&["view", "1", "--json"]);
    assert_eq!(v["task"]["status"], "todo");
    let last = v["history"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|e| e["kind"] == "rejected")
        .expect("the rejection is recorded");
    assert_eq!(
        last["actor"], "codex",
        "the history names the agent that recorded it"
    );
    assert_eq!(last["message"], "ボタンの色を変えて");

    c.json(&["--as", "codex", "start", "1", "--json"]);
    c.json(&[
        "--as",
        "codex",
        "done",
        "1",
        "--summary",
        "Changed",
        "--json",
    ]);
    c.json(&[
        "--as",
        "codex",
        "approve",
        "1",
        "--comment",
        "いいね",
        "--json",
    ]);
    let v = c.json(&["view", "1", "--json"]);
    assert_eq!(v["task"]["status"], "done");
    assert!(
        v["history"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "approved" && e["actor"] == "codex" && e["message"] == "いいね")
    );
}

#[test]
fn ignores_and_restores_repositories() {
    let cli = Cli::new();
    let added = cli.json(&["gh", "ignore", "add", "o/noise", "--json"]);
    assert_eq!(added, json!({"repo": "o/noise", "deleted": 0}));
    let listed = cli.json(&["gh", "ignore", "list", "--json"]);
    assert_eq!(listed["ignored_repos"], json!(["o/noise"]));
    let plain = cli.run(&["gh", "ignore", "list"]);
    assert_eq!(String::from_utf8_lossy(&plain.stdout), "o/noise\n");
    let removed = cli.json(&["gh", "ignore", "remove", "o/noise", "--json"]);
    assert_eq!(removed["removed"], true);
    let bad = cli.run(&["gh", "ignore", "add", "not-a-repo"]);
    assert!(!bad.status.success(), "a malformed repository is refused");
}
