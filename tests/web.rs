use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use task_tool::github::{GhError, GhRunner};
use task_tool::sync::Syncer;
use task_tool::web::{self, AppState, HostPolicy};
use task_tool::{NewSubtask, NewTask, Store};
use tower::ServiceExt;

#[derive(Default)]
struct FakeGh {
    calls: Mutex<Vec<Vec<String>>>,
    reply: Mutex<Option<String>>,
}

impl GhRunner for FakeGh {
    fn run(&self, args: &[String]) -> Result<String, GhError> {
        self.calls.lock().unwrap().push(args.to_vec());
        self.reply
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| GhError::Failed("no reply queued".into()))
    }
}

struct App {
    router: Router,
    gh: Arc<FakeGh>,
    sync: Syncer,
    store: Store,
}

fn app() -> App {
    let gh = Arc::new(FakeGh::default());
    let store = Store::open_in_memory().unwrap();
    let sync = Syncer::new(store.clone(), gh.clone());
    let state = AppState {
        sync: sync.clone(),
        store: store.clone(),
        hosts: HostPolicy::LoopbackOnly,
        mcp_command: None,
    };
    App {
        router: web::router(state),
        gh,
        sync,
        store,
    }
}

fn add(store: &Store, title: &str) -> task_tool::Task {
    store
        .create(NewTask {
            title: title.into(),
            workdir: Some("/work".into()),
            ..NewTask::default()
        })
        .unwrap()
}

impl App {
    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:7878");
        if method != "GET" {
            req = req.header(header::CONTENT_TYPE, "application/json");
        }
        let body = match body {
            Some(v) => Body::from(v.to_string()),
            None => Body::empty(),
        };
        let res = self
            .router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        (status, value)
    }
}

#[tokio::test]
async fn reports_the_background_sync_status() {
    let app = app();
    *app.gh.reply.lock().unwrap() = Some(
        r#"{"data":{"search":{"nodes":[{"number": 3, "title": "From GH", "body": "", "state": "open",
             "url": "https://github.com/x/y/issues/3", "repository": {"nameWithOwner": "x/y"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#
            .into(),
    );
    let (_, before) = app.send("GET", "/api/sync", None).await;
    assert!(before["last_finished_at"].is_null());

    app.sync.run_once();

    let (status, after) = app.send("GET", "/api/sync", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["last_report"], json!({"created": 1, "updated": 0}));
    assert_eq!(after["interval_secs"], 300);
    let (_, tasks) = app.send("GET", "/api/tasks", None).await;
    assert_eq!(tasks[0]["github"]["repo"], "x/y");
}

#[tokio::test]
async fn there_is_no_manual_import_endpoint() {
    let app = app();
    let (status, _) = app
        .send("POST", "/api/github/import", Some(json!({})))
        .await;
    assert!(status.is_client_error(), "got {status}");
    assert!(app.gh.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn serves_the_admin_page_and_kav_ui_assets() {
    let app = app();
    let (status, html) = app.send("GET", "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.as_str().unwrap().contains("vendor/kav-ui/css/ui.css"));

    let (status, _) = app.send("GET", "/vendor/kav-ui/js/ui.js", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = app.send("GET", "/nope.txt", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rejects_foreign_host_headers_to_block_dns_rebinding() {
    let app = app();
    let req = Request::builder()
        .uri("/api/tasks")
        .header(header::HOST, "evil.example:7878")
        .body(Body::empty())
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    for host in ["localhost:7878", "[::1]:7878", "127.0.0.1"] {
        let req = Request::builder()
            .uri("/api/tasks")
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap();
        let res = app.router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{host}");
    }
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

impl App {
    async fn send_bytes(&self, method: &str, uri: &str, body: Vec<u8>) -> axum::response::Response {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:7878")
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(Body::from(body))
            .unwrap();
        self.router.clone().oneshot(req).await.unwrap()
    }
}

#[tokio::test]
async fn background_settings_start_with_defaults_and_no_image() {
    let app = app();
    let (status, settings) = app.send("GET", "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        settings["background"],
        json!({"opacity": 18, "position": "center", "size": "cover", "image": null})
    );
}

#[tokio::test]
async fn uploads_serves_and_deletes_the_background_image() {
    let app = app();

    let res = app
        .send_bytes("PUT", "/api/settings/background/image", PNG.to_vec())
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let (_, settings) = app.send("GET", "/api/settings", None).await;
    let image = &settings["background"]["image"];
    assert_eq!(image["content_type"], "image/png");
    assert_eq!(image["bytes"], PNG.len());
    let url = image["url"].as_str().unwrap();
    assert!(
        url.starts_with("/api/settings/background/image?v="),
        "{url}"
    );

    let res = app.send_bytes("GET", url, Vec::new()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], PNG);

    let (status, settings) = app
        .send("DELETE", "/api/settings/background/image", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(settings["background"]["image"].is_null());
    let res = app
        .send_bytes("GET", "/api/settings/background/image", Vec::new())
        .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rejects_non_images_and_oversized_uploads() {
    let app = app();

    let res = app
        .send_bytes(
            "PUT",
            "/api/settings/background/image",
            b"<svg onload='alert(1)'/>".to_vec(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let mut huge = PNG.to_vec();
    huge.resize(task_tool::settings::MAX_IMAGE_BYTES + 1, 0);
    let res = app
        .send_bytes("PUT", "/api/settings/background/image", huge)
        .await;
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let (_, settings) = app.send("GET", "/api/settings", None).await;
    assert!(settings["background"]["image"].is_null());
}

#[tokio::test]
async fn updates_how_the_background_is_drawn() {
    let app = app();

    let (status, settings) = app
        .send(
            "PATCH",
            "/api/settings/background",
            Some(json!({"opacity": 45, "size": "contain"})),
        )
        .await;

    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["background"]["opacity"], 45);
    assert_eq!(settings["background"]["size"], "contain");
    assert_eq!(settings["background"]["position"], "center", "unchanged");

    let (status, _) = app
        .send(
            "PATCH",
            "/api/settings/background",
            Some(json!({"opacity": 150})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app
        .send(
            "PATCH",
            "/api/settings/background",
            Some(json!({"position": "diagonal"})),
        )
        .await;
    assert!(status.is_client_error(), "got {status}");
}

#[tokio::test]
async fn shows_tasks_with_subtasks_and_history() {
    let app = app();
    let parent = add(&app.store, "Release");
    app.store
        .create_subtasks(
            parent.id,
            vec![NewSubtask {
                title: "Changelog".into(),
                description: String::new(),
            }],
            "claude-code",
        )
        .unwrap();
    app.store
        .add_note(parent.id, "claude-code", "split into one step")
        .unwrap();

    let (_, top) = app.send("GET", "/api/tasks", None).await;
    assert_eq!(top.as_array().unwrap().len(), 1, "top-level by default");
    let (_, all) = app.send("GET", "/api/tasks?scope=all", None).await;
    assert_eq!(all.as_array().unwrap().len(), 2);

    let (status, detail) = app
        .send("GET", &format!("/api/tasks/{}", parent.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["task"]["workdir"], "/work");
    assert_eq!(detail["subtasks"][0]["title"], "Changelog");
    assert_eq!(detail["history"][0]["message"], "split into one step");
    assert!(detail.get("runs").is_none());
    assert!(
        detail.get("agent_prompt").is_none(),
        "no copy-paste step for people"
    );

    let (status, body) = app.send("GET", "/api/tasks/999", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].as_str().unwrap().contains("not found"));
}

#[tokio::test]
async fn reports_dashboard_stats_and_activity() {
    let app = app();
    let task = add(&app.store, "T");
    app.store.start_task(task.id, "claude-code").unwrap();

    let (status, stats) = app.send("GET", "/api/stats", None).await;
    assert_eq!(status, StatusCode::OK, "{stats}");
    assert_eq!(stats["by_status"]["in_progress"], 1);
    assert_eq!(stats["agents"][0]["name"], "claude-code");
    assert!(stats.get("review_queue").is_none());

    let (_, latest) = app.send("GET", "/api/activity/latest", None).await;
    let (_, feed) = app.send("GET", "/api/activity?limit=1", None).await;
    assert_eq!(feed[0]["id"], latest["id"]);
}

#[tokio::test]
async fn organizes_tasks_and_records_user_history() {
    let app = app();
    let (status, task) = app
        .send(
            "POST",
            "/api/tasks",
            Some(json!({"title":"Parent", "workdir":"/work"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{task}");
    let id = task["id"].as_i64().unwrap();
    let path = format!("/api/tasks/{id}");
    let (status, child) = app
        .send(
            "POST",
            &format!("{path}/subtasks"),
            Some(json!({"title":"Child"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    assert_eq!(child["workdir"], "/work");
    let child_id = child["id"].as_i64().unwrap();
    let (status, edited) = app
        .send(
            "PATCH",
            &format!("/api/tasks/{child_id}"),
            Some(json!({"title":"Edited", "description":"Details", "status":"done"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["title"], "Edited");
    let (_, detail) = app.send("GET", &path, None).await;
    assert_eq!(detail["task"]["status"], "done");
    assert!(detail.get("runs").is_none());
    let (status, _) = app
        .send(
            "POST",
            &format!("{path}/notes"),
            Some(json!({"message":"Memo"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, detail) = app.send("GET", &path, None).await;
    assert_eq!(detail["history"][0]["actor"], "user");
    assert_eq!(detail["history"][0]["message"], "Memo");
    let (status, deleted) = app.send("DELETE", &path, Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["id"], id);
    assert!(app.store.get(child_id).unwrap().is_none());
}

#[tokio::test]
async fn validates_writes_and_missing_tasks() {
    let app = app();
    for body in [
        json!({"title":" "}),
        json!({"title":"x".repeat(task_tool::MAX_TITLE_CHARS + 1)}),
    ] {
        assert_eq!(
            app.send("POST", "/api/tasks", Some(body)).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for (method, path, body) in [
        ("PATCH", "/api/tasks/999", json!({"status":"done"})),
        ("DELETE", "/api/tasks/999", json!({})),
        ("POST", "/api/tasks/999/subtasks", json!({"title":"Child"})),
        ("POST", "/api/tasks/999/notes", json!({"message":"Memo"})),
        (
            "POST",
            "/api/tasks",
            json!({"title":"Child", "parent_id":999}),
        ),
    ] {
        assert_eq!(
            app.send(method, path, Some(body)).await.0,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    let id = add(&app.store, "Task").id;
    for (path, body) in [
        (format!("/api/tasks/{id}"), json!({"title":""})),
        (format!("/api/tasks/{id}"), json!({"status":"invalid"})),
    ] {
        assert_eq!(
            app.send("PATCH", &path, Some(body)).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        app.send(
            "POST",
            &format!("/api/tasks/{id}/notes"),
            Some(json!({"message":" "}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn rejects_cross_site_and_non_json_writes() {
    let app = app();
    for (path, method) in [
        ("/api/tasks", "POST"),
        ("/api/tasks/1", "PATCH"),
        ("/api/tasks/1", "DELETE"),
        ("/api/tasks/1/subtasks", "POST"),
        ("/api/tasks/1/notes", "POST"),
        ("/api/settings/background", "PATCH"),
        ("/api/settings/background/image", "PUT"),
        ("/api/settings/background/image", "DELETE"),
    ] {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "127.0.0.1:7878")
            .header(header::ORIGIN, "http://evil.example")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            app.router.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "{path}"
        );
        if !path.ends_with("/image") {
            let req = Request::builder()
                .method(method)
                .uri(path)
                .header(header::HOST, "127.0.0.1:7878")
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from("{}"))
                .unwrap();
            assert_eq!(
                app.router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::FORBIDDEN,
                "{path}"
            );
        }
    }
    let req = Request::builder()
        .method("POST")
        .uri("/api/tasks")
        .header(header::HOST, "127.0.0.1:7878")
        .header(header::ORIGIN, "http://127.0.0.1:7878")
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(r#"{"title":"Allowed"}"#))
        .unwrap();
    assert_eq!(
        app.router.clone().oneshot(req).await.unwrap().status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn review_api_returns_sessions_timeline_and_records_decisions() {
    let app = app();
    let root = add(&app.store, "Parent");
    let child = app
        .store
        .create_subtasks(
            root.id,
            vec![NewSubtask {
                title: "Child".into(),
                description: String::new(),
            }],
            "agent",
        )
        .unwrap()
        .remove(0);
    app.store.start_task(child.id, "agent").unwrap();
    app.store
        .complete_task(child.id, "agent", "Verified\nMore detail")
        .unwrap();
    let (_, detail) = app
        .send("GET", &format!("/api/tasks/{}", child.id), None)
        .await;
    assert_eq!(detail["sessions"][0]["outcome"], "reported");
    let (_, stats) = app.send("GET", "/api/stats", None).await;
    assert_eq!(stats["awaiting_review"][0]["summary"], "Verified");
    let (status, _) = app
        .send(
            "POST",
            &format!("/api/tasks/{}/review", child.id),
            Some(json!({"decision":"reject","comment":" "})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, rejected) = app
        .send(
            "POST",
            &format!("/api/tasks/{}/review", child.id),
            Some(json!({"decision":"reject","comment":"More tests"})),
        )
        .await;
    assert_eq!(rejected["status"], "todo");
    assert!(rejected["assignee"].is_null());
    app.store.start_task(child.id, "agent").unwrap();
    app.store
        .complete_task(child.id, "agent", "Retested")
        .unwrap();
    let (_, approved) = app
        .send(
            "POST",
            &format!("/api/tasks/{}/review", child.id),
            Some(json!({"decision":"approve"})),
        )
        .await;
    assert_eq!(approved["status"], "done");
    assert_eq!(
        app.store.get(root.id).unwrap().unwrap().status,
        task_tool::Status::Done
    );
    let (status, timeline) = app
        .send("GET", &format!("/api/tasks/{}/timeline", child.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let items = timeline.as_array().unwrap();
    assert!(items.iter().any(|i| i["task_id"] == root.id));
    assert!(
        items
            .iter()
            .any(|i| i["event"]["kind"] == "rejected" && i["event"]["message"] == "More tests")
    );
}

#[tokio::test]
async fn external_content_patch_conflicts_but_status_and_unchanged_content_work() {
    let app = app();
    let task = add(&app.store, "Issue");
    app.store
        .link_github(
            task.id,
            &task_tool::GithubLink {
                repo: "o/r".into(),
                number: 1,
                url: "https://github.com/o/r/issues/1".into(),
            },
        )
        .unwrap();
    for patch in [json!({"title":"Changed"}), json!({"description":"Changed"})] {
        let (status, body) = app
            .send("PATCH", &format!("/api/tasks/{}", task.id), Some(patch))
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.to_string().contains("GitHub"));
    }
    let (status, _) = app
        .send(
            "PATCH",
            &format!("/api/tasks/{}", task.id),
            Some(json!({"title":"Issue","description":"","status":"in_progress"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}
