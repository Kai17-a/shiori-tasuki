//! JSON API and dashboard for organizing a personal task list.

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::activity::Event;
use crate::settings::{
    BackgroundPosition, BackgroundSettings, BackgroundSize, ImageError, ImageInfo, MAX_IMAGE_BYTES,
};
use crate::stats::Stats;
use crate::store::{Scope, Store, StoreError};
use crate::sync::{SyncStatus, Syncer};
use crate::task::{NewSubtask, NewTask, Status, Task, TaskUpdate};

/// The admin page and the Kav-UI assets, compiled into the binary.
static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web");

/// Which `Host` headers the server answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPolicy {
    /// Only `localhost`, `127.0.0.1` and `[::1]`; blocks DNS-rebinding pages from
    /// reaching an API that has no login.
    LoopbackOnly,
    Any,
}

/// Shared state of the HTTP server.
#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub hosts: HostPolicy,
    /// Command shown on the admin page for registering the MCP server with an agent.
    pub mcp_command: Option<String>,
    /// Background GitHub sync whose status the dashboard shows.
    pub sync: Syncer,
}

/// Builds the router serving `/api/*` and the admin page.
pub fn router(state: AppState) -> Router {
    let hosts = state.hosts;
    Router::new()
        .route("/api/config", get(config))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{id}",
            get(show_task).patch(update_task).delete(delete_task),
        )
        .route("/api/tasks/{id}/subtasks", post(create_subtask))
        .route("/api/tasks/{id}/notes", post(add_note))
        .route("/api/tasks/{id}/review", post(review_task))
        .route("/api/tasks/{id}/timeline", get(timeline))
        .route("/api/activity", get(activity))
        .route("/api/activity/latest", get(latest_activity))
        .route("/api/sync", get(sync_status))
        .route("/api/stats", get(stats))
        .route("/api/settings", get(settings))
        .route("/api/settings/background", patch(update_background))
        .route(
            "/api/settings/background/image",
            get(background_image)
                .put(upload_background_image)
                .delete(delete_background_image)
                // One byte over the limit lets the handler report the size precisely.
                .layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES + 1)),
        )
        .fallback(static_file)
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            check_host(hosts, req, next)
        }))
        .with_state(state)
}

async fn check_host(policy: HostPolicy, req: Request, next: Next) -> Response {
    if policy == HostPolicy::LoopbackOnly {
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if !is_loopback_host(host) {
            return (StatusCode::FORBIDDEN, "host not allowed").into_response();
        }
    }
    if req.method() != axum::http::Method::GET {
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if let Some(origin) = req.headers().get(header::ORIGIN)
            && origin.to_str().ok() != Some(format!("http://{host}").as_str())
        {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
        // Image bytes retain their existing upload API; every write still checks Origin.
        let image_upload = req.uri().path() == "/api/settings/background/image"
            && req.method() == axum::http::Method::PUT;
        let json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| {
                h.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        if !image_upload && !json {
            return (StatusCode::FORBIDDEN, "application/json required").into_response();
        }
    }
    next.run(req).await
}

fn is_loopback_host(host: &str) -> bool {
    let name = if host.starts_with('[') {
        host.split_once(']').map_or(host, |(name, _)| &name[1..])
    } else {
        host.split_once(':').map_or(host, |(name, _)| name)
    };
    matches!(name, "localhost" | "127.0.0.1" | "::1")
}

/// Error body: `{"error": "..."}` with a status matching the cause.
#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        let status = match err {
            StoreError::ExternalContent => StatusCode::CONFLICT,
            StoreError::NotFound(_) => StatusCode::NOT_FOUND,
            StoreError::Invalid(_) => StatusCode::BAD_REQUEST,
            StoreError::Db(_) | StoreError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, err.to_string())
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Runs blocking storage or `gh` work off the async executor.
async fn blocking<T, E>(work: impl FnOnce() -> Result<T, E> + Send + 'static) -> ApiResult<T>
where
    T: Send + 'static,
    E: Into<ApiError> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(Into::into)
}

async fn config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "mcp_command": state.mcp_command,
        "statuses": Status::ALL,
    }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ScopeParam {
    #[default]
    Top,
    All,
}

#[derive(Debug, Deserialize)]
struct ListParams {
    #[serde(default)]
    scope: ScopeParam,
    parent_id: Option<i64>,
}

async fn list_tasks(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<Vec<Task>>> {
    let scope = match (params.parent_id, params.scope) {
        (Some(id), _) => Scope::ChildrenOf(id),
        (None, ScopeParam::All) => Scope::All,
        (None, ScopeParam::Top) => Scope::TopLevel,
    };
    blocking(move || state.store.list(scope)).await.map(Json)
}

#[derive(Debug, Serialize)]
struct TaskDetail {
    task: Task,
    subtasks: Vec<Task>,
    /// Recent history, newest first.
    history: Vec<Event>,
    sessions: Vec<crate::work::WorkSession>,
}

async fn show_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<TaskDetail>> {
    blocking(move || {
        let task = state.store.get(id)?.ok_or(StoreError::NotFound(id))?;
        let subtasks = state.store.list(Scope::ChildrenOf(id))?;
        let history = state.store.events_for(id, TASK_HISTORY_LIMIT)?;
        Ok::<_, StoreError>(TaskDetail {
            task,
            subtasks,
            history,
            sessions: state.store.sessions(id)?,
        })
    })
    .await
    .map(Json)
}

/// History entries shown in the task drawer.
const TASK_HISTORY_LIMIT: u32 = 50;

/// Largest page of the activity feed.
const MAX_ACTIVITY_PAGE: u32 = 200;

#[derive(Debug, Deserialize)]
struct ActivityParams {
    limit: Option<u32>,
    before: Option<i64>,
}

async fn activity(
    State(state): State<AppState>,
    Query(params): Query<ActivityParams>,
) -> ApiResult<Json<Vec<Event>>> {
    let limit = params.limit.unwrap_or(50).clamp(1, MAX_ACTIVITY_PAGE);
    blocking(move || state.store.activity(limit, params.before))
        .await
        .map(Json)
}

async fn latest_activity(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    let id = blocking(move || state.store.latest_event_id()).await?;
    Ok(Json(json!({ "id": id })))
}

async fn sync_status(State(state): State<AppState>) -> Json<SyncStatus> {
    Json(state.sync.status())
}

async fn stats(State(state): State<AppState>) -> ApiResult<Json<Stats>> {
    blocking(move || state.store.stats()).await.map(Json)
}

impl From<ImageError> for ApiError {
    fn from(err: ImageError) -> Self {
        match err {
            ImageError::Unsupported => Self(StatusCode::UNSUPPORTED_MEDIA_TYPE, err.to_string()),
            ImageError::TooLarge(_) => Self(StatusCode::PAYLOAD_TOO_LARGE, err.to_string()),
            ImageError::Store(e) => e.into(),
        }
    }
}

#[derive(Debug, Serialize)]
struct SettingsView {
    background: BackgroundView,
}

#[derive(Debug, Serialize)]
struct BackgroundView {
    #[serde(flatten)]
    settings: BackgroundSettings,
    image: Option<ImageView>,
}

#[derive(Debug, Serialize)]
struct ImageView {
    /// Changes whenever the image is replaced, so browsers never show a stale copy.
    url: String,
    content_type: String,
    bytes: usize,
    updated_at: String,
}

impl From<ImageInfo> for ImageView {
    fn from(info: ImageInfo) -> Self {
        let version: String = info
            .updated_at
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        Self {
            url: format!("/api/settings/background/image?v={version}-{}", info.bytes),
            content_type: info.content_type,
            bytes: info.bytes,
            updated_at: info.updated_at,
        }
    }
}

fn settings_view(store: &Store) -> Result<SettingsView, StoreError> {
    Ok(SettingsView {
        background: BackgroundView {
            settings: store.background_settings()?,
            image: store.background_image_info()?.map(ImageView::from),
        },
    })
}

async fn settings(State(state): State<AppState>) -> ApiResult<Json<SettingsView>> {
    blocking(move || settings_view(&state.store))
        .await
        .map(Json)
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct BackgroundPatch {
    opacity: Option<u8>,
    position: Option<BackgroundPosition>,
    size: Option<BackgroundSize>,
}

async fn update_background(
    State(state): State<AppState>,
    Json(patch): Json<BackgroundPatch>,
) -> ApiResult<Json<SettingsView>> {
    blocking(move || {
        let current = state.store.background_settings()?;
        state.store.set_background_settings(&BackgroundSettings {
            opacity: patch.opacity.unwrap_or(current.opacity),
            position: patch.position.unwrap_or(current.position),
            size: patch.size.unwrap_or(current.size),
        })?;
        settings_view(&state.store)
    })
    .await
    .map(Json)
}

async fn upload_background_image(
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<Json<SettingsView>> {
    blocking(move || {
        state.store.set_background_image(&body)?;
        Ok::<_, ImageError>(settings_view(&state.store)?)
    })
    .await
    .map(Json)
}

async fn delete_background_image(State(state): State<AppState>) -> ApiResult<Json<SettingsView>> {
    blocking(move || {
        state.store.delete_background_image()?;
        settings_view(&state.store)
    })
    .await
    .map(Json)
}

async fn background_image(State(state): State<AppState>) -> ApiResult<Response> {
    let image = blocking(move || state.store.background_image()).await?;
    let Some(image) = image else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "no background image".into(),
        ));
    };
    Ok((
        [
            (header::CONTENT_TYPE, image.content_type),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            // The URL carries a version, so the bytes behind it never change.
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_owned(),
            ),
        ],
        image.data,
    )
        .into_response())
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match WEB.get_file(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref().to_owned())],
                file.contents(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_host;

    #[test]
    fn recognises_loopback_hosts() {
        for host in [
            "localhost",
            "localhost:1",
            "127.0.0.1:80",
            "[::1]:7878",
            "[::1]",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in [
            "",
            "example.com",
            "127.0.0.1.evil.com",
            "[::2]:1",
            "localhost.evil:1",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTask {
    title: String,
    #[serde(default)]
    description: String,
    parent_id: Option<i64>,
    workdir: Option<String>,
}

async fn create_task(
    State(state): State<AppState>,
    body: Result<Json<CreateTask>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<(StatusCode, Json<Task>)> {
    let Json(body) = body.map_err(bad_json)?;
    let task = blocking(move || {
        state.store.create(NewTask {
            title: body.title,
            description: body.description,
            parent_id: body.parent_id,
            workdir: body.workdir.filter(|s| !s.trim().is_empty()),
            ..NewTask::default()
        })
    })
    .await?;
    Ok((StatusCode::CREATED, Json(task)))
}

fn bad_json(error: axum::extract::rejection::JsonRejection) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, error.body_text())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskPatch {
    title: Option<String>,
    description: Option<String>,
    status: Option<Status>,
}

async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<TaskPatch>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Task>> {
    let Json(body) = body.map_err(bad_json)?;
    blocking(move || {
        state.store.update_as(
            id,
            TaskUpdate {
                title: body.title,
                description: body.description,
                status: body.status,
                ..TaskUpdate::default()
            },
            "user",
        )
    })
    .await
    .map(Json)
}

async fn delete_task(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Task>> {
    blocking(move || {
        let task = state.store.get(id)?.ok_or(StoreError::NotFound(id))?;
        state.store.delete(id)?;
        Ok::<_, StoreError>(task)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubtaskBody {
    title: String,
    #[serde(default)]
    description: String,
}

async fn create_subtask(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<SubtaskBody>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<(StatusCode, Json<Task>)> {
    let Json(body) = body.map_err(bad_json)?;
    let task = blocking(move || {
        let mut tasks = state.store.create_subtasks(
            id,
            vec![NewSubtask {
                title: body.title,
                description: body.description,
            }],
            "user",
        )?;
        Ok::<_, StoreError>(tasks.remove(0))
    })
    .await?;
    Ok((StatusCode::CREATED, Json(task)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteBody {
    message: String,
}

async fn add_note(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<NoteBody>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Task>> {
    let Json(body) = body.map_err(bad_json)?;
    blocking(move || {
        state.store.add_note(id, "user", &body.message)?;
        state.store.get(id)?.ok_or(StoreError::NotFound(id))
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewBody {
    decision: String,
    #[serde(default)]
    comment: String,
}
async fn review_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<ReviewBody>,
) -> ApiResult<Json<Task>> {
    let approve = match body.decision.as_str() {
        "approve" => true,
        "reject" => false,
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "decision must be approve or reject".into(),
            ));
        }
    };
    blocking(move || state.store.review_task(id, "user", approve, &body.comment))
        .await
        .map(Json)
}
async fn timeline(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Vec<crate::work::TimelineItem>>> {
    blocking(move || state.store.timeline(id)).await.map(Json)
}
