use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;
use yrs::{updates::decoder::Decode, Doc, ReadTxn, StateVector, Transact, Update};

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        list_issues,
        get_issue,
        create_issue,
        update_issue,
        delete_issue,
    ),
    components(schemas(Issue, CreateIssue, UpdateIssue, IssueListResponse, HealthResponse)),
    info(
        title = "Photon API",
        version = "0.1.0",
        description = "Photon backend REST API"
    )
)]
struct ApiDoc;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    pub project: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct IssueRecord {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub labels: String,
    pub project: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<IssueRecord> for Issue {
    fn from(record: IssueRecord) -> Self {
        Self {
            id: record.id,
            identifier: record.identifier,
            title: record.title,
            description: record.description,
            status: record.status,
            priority: record.priority,
            assignee: record.assignee,
            labels: parse_labels(&record.labels),
            project: record.project,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateIssue {
    pub title: String,
    pub identifier: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub assignee: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default = "default_project")]
    pub project: String,
}

fn default_status() -> String {
    "todo".into()
}
fn default_priority() -> String {
    "none".into()
}
fn default_project() -> String {
    "Client App Kit".into()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateIssue {
    pub identifier: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_text")]
    pub assignee: Option<Option<String>>,
    pub labels: Option<Vec<String>>,
    pub project: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct IssueListResponse {
    pub issues: Vec<Issue>,
    pub total: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

fn now_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

fn deserialize_nullable_text<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn parse_labels(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn serialize_labels(labels: &[String]) -> String {
    serde_json::to_string(labels).unwrap_or_else(|_| "[]".into())
}

async fn next_issue_identifier(pool: &SqlitePool) -> Result<String, sqlx::Error> {
    let max_number: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(CAST(SUBSTR(identifier, 5) AS INTEGER))
         FROM issues
         WHERE identifier LIKE 'PLT-%'",
    )
    .fetch_one(pool)
    .await?;

    Ok(format!("PLT-{}", max_number.unwrap_or(100) + 1))
}

async fn fetch_issue_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Issue>, sqlx::Error> {
    let issue = sqlx::query_as::<_, IssueRecord>(
        "SELECT id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .map(Into::into);

    Ok(issue)
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub db: SqlitePool,
    pub doc: RwLock<Doc>,
    pub broadcast_tx: broadcast::Sender<Vec<u8>>,
    pub presence_tx: broadcast::Sender<String>,
    pub active_connections: AtomicUsize,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/health",
    responses((status = 200, description = "Service is healthy", body = HealthResponse)),
    tag = "health"
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
    })
}

#[utoipa::path(
    get,
    path = "/api/issues",
    params(
        ("limit" = Option<i64>, Query, description = "Max items to return"),
        ("offset" = Option<i64>, Query, description = "Items to skip"),
    ),
    responses((status = 200, description = "List of issues", body = IssueListResponse)),
    tag = "issues"
)]
async fn list_issues(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<IssueListResponse>, AppError> {
    let limit = params.limit.unwrap_or(50);
    let offset = params.offset.unwrap_or(0);

    let issue_records = sqlx::query_as::<_, IssueRecord>(
        "SELECT id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at
         FROM issues ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;
    let issues = issue_records.into_iter().map(Into::into).collect();

    let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM issues")
        .fetch_one(&state.db)
        .await?;

    Ok(Json(IssueListResponse {
        issues,
        total: total.0,
    }))
}

#[utoipa::path(
    get,
    path = "/api/issues/:id",
    params(("id" = String, Path, description = "Issue ID")),
    responses(
        (status = 200, description = "Issue found", body = Issue),
        (status = 404, description = "Issue not found"),
    ),
    tag = "issues"
)]
async fn get_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Issue>, AppError> {
    let issue = fetch_issue_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(issue))
}

#[utoipa::path(
    post,
    path = "/api/issues",
    request_body = CreateIssue,
    responses((status = 201, description = "Issue created", body = Issue)),
    tag = "issues"
)]
async fn create_issue(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateIssue>,
) -> Result<(StatusCode, Json<Issue>), AppError> {
    let id = Uuid::new_v4().to_string();
    let identifier = match normalize_optional_text(payload.identifier) {
        Some(identifier) => identifier,
        None => next_issue_identifier(&state.db).await?,
    };
    let assignee = normalize_optional_text(payload.assignee);
    let labels = serialize_labels(&payload.labels);
    let project = if payload.project.trim().is_empty() {
        default_project()
    } else {
        payload.project
    };
    let now = now_timestamp();

    sqlx::query(
        "INSERT INTO issues (id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&identifier)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(&payload.status)
    .bind(&payload.priority)
    .bind(&assignee)
    .bind(&labels)
    .bind(&project)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let issue = fetch_issue_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok((StatusCode::CREATED, Json(issue)))
}

#[utoipa::path(
    put,
    path = "/api/issues/:id",
    params(("id" = String, Path, description = "Issue ID")),
    request_body = UpdateIssue,
    responses(
        (status = 200, description = "Issue updated", body = Issue),
        (status = 404, description = "Issue not found"),
    ),
    tag = "issues"
)]
async fn update_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateIssue>,
) -> Result<Json<Issue>, AppError> {
    // Check exists
    let existing = sqlx::query_as::<_, IssueRecord>(
        "SELECT id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let identifier = normalize_optional_text(payload.identifier).unwrap_or(existing.identifier);
    let title = payload.title.unwrap_or(existing.title);
    let description = payload.description.unwrap_or(existing.description);
    let status = payload.status.unwrap_or(existing.status);
    let priority = payload.priority.unwrap_or(existing.priority);
    let assignee = match payload.assignee {
        Some(value) => normalize_optional_text(value),
        None => existing.assignee,
    };
    let labels = payload
        .labels
        .map(|labels| serialize_labels(&labels))
        .unwrap_or(existing.labels);
    let project = payload.project.unwrap_or(existing.project);
    let now = now_timestamp();

    sqlx::query(
        "UPDATE issues SET identifier = ?, title = ?, description = ?, status = ?, priority = ?, assignee = ?, labels = ?, project = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&identifier)
    .bind(&title)
    .bind(&description)
    .bind(&status)
    .bind(&priority)
    .bind(&assignee)
    .bind(&labels)
    .bind(&project)
    .bind(&now)
    .bind(&id)
    .execute(&state.db)
    .await?;

    let issue = fetch_issue_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(issue))
}

#[utoipa::path(
    delete,
    path = "/api/issues/:id",
    params(("id" = String, Path, description = "Issue ID")),
    responses(
        (status = 204, description = "Issue deleted"),
        (status = 404, description = "Issue not found"),
    ),
    tag = "issues"
)]
async fn delete_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM issues WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// WebSocket — yrs CRDT sync
// ---------------------------------------------------------------------------

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let active_count = state.active_connections.fetch_add(1, Ordering::SeqCst) + 1;

    // Send initial state — scope the transaction so it's dropped before await
    let initial_update = {
        let doc = state.doc.read().await;
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };
    if ws_sender
        .send(Message::Binary(initial_update))
        .await
        .is_err()
    {
        state.active_connections.fetch_sub(1, Ordering::SeqCst);
        return;
    }

    // Subscribe to broadcast channel for updates from other clients
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let mut presence_rx = state.presence_tx.subscribe();
    let _ = state.presence_tx.send(format!(
        r#"{{"type":"presence","onlineCount":{active_count}}}"#
    ));

    // Task: forward broadcast messages to this client's WebSocket
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Ok(data) = broadcast_rx.recv() => {
                    if ws_sender.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Ok(presence) = presence_rx.recv() => {
                    if ws_sender.send(Message::Text(presence)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Task: receive updates from this client, apply to doc, broadcast
    let recv_state = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => {
                    let doc = recv_state.doc.write().await;
                    if let Ok(update) = Update::decode_v1(&data) {
                        let mut txn = doc.transact_mut();
                        if txn.apply_update(update).is_ok() {
                            // Broadcast to all connected clients
                            let _ = recv_state.broadcast_tx.send(data.to_vec());
                        }
                    }
                    drop(doc);
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish, then clean up
    tokio::select! {
        _ = &mut send_task => {},
        _ = &mut recv_task => {},
    }
    send_task.abort();
    recv_task.abort();

    let active_count = state.active_connections.fetch_sub(1, Ordering::SeqCst) - 1;
    let _ = state.presence_tx.send(format!(
        r#"{{"type":"presence","onlineCount":{active_count}}}"#
    ));
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum AppError {
    NotFound,
    Sqlx(sqlx::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Sqlx(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found"),
            AppError::Sqlx(e) => {
                tracing::error!("Database error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let migration_sql = include_str!("../migrations/001_create_issues.sql");
    sqlx::raw_sql(migration_sql).execute(pool).await?;
    ensure_issue_projection_columns(pool).await?;
    Ok(())
}

async fn issue_table_has_column(pool: &SqlitePool, column_name: &str) -> Result<bool, sqlx::Error> {
    let columns = sqlx::query_as::<_, (String,)>("SELECT name FROM pragma_table_info('issues')")
        .fetch_all(pool)
        .await?;

    Ok(columns.iter().any(|(name,)| name == column_name))
}

async fn ensure_issue_projection_columns(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    if !issue_table_has_column(pool, "identifier").await? {
        sqlx::query("ALTER TABLE issues ADD COLUMN identifier TEXT")
            .execute(pool)
            .await?;
    }

    if !issue_table_has_column(pool, "labels").await? {
        sqlx::query("ALTER TABLE issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'")
            .execute(pool)
            .await?;
    }

    if !issue_table_has_column(pool, "project").await? {
        sqlx::query("ALTER TABLE issues ADD COLUMN project TEXT NOT NULL DEFAULT 'Client App Kit'")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        "UPDATE issues
         SET identifier = 'PLT-' || (rowid + 100)
         WHERE identifier IS NULL OR identifier = ''",
    )
    .execute(pool)
    .await?;

    sqlx::query("UPDATE issues SET labels = '[]' WHERE labels IS NULL OR labels = ''")
        .execute(pool)
        .await?;
    sqlx::query(
        "UPDATE issues
         SET project = 'Client App Kit'
         WHERE project IS NULL OR project = ''",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project)")
        .execute(pool)
        .await?;

    Ok(())
}

async fn seed_if_empty(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM issues")
        .fetch_one(pool)
        .await?;

    if count.0 > 0 {
        return Ok(());
    }

    let seeds = vec![
        (
            "Set up project repository",
            "Initialize the monorepo structure with frontend and backend packages",
            "done",
            "urgent",
            Some("Alice"),
            vec!["infra"],
            "Photon Core",
        ),
        (
            "Design database schema",
            "Define tables for issues, users, and projects",
            "done",
            "high",
            Some("Bob"),
            vec!["database"],
            "Photon Core",
        ),
        (
            "Implement authentication",
            "Add JWT-based auth with login/register endpoints",
            "in_progress",
            "urgent",
            Some("Alice"),
            vec!["auth"],
            "Auth Service",
        ),
        (
            "Build issue list view",
            "Create the main table view for browsing issues",
            "in_progress",
            "high",
            Some("Charlie"),
            vec!["feature", "ui"],
            "Client App Kit",
        ),
        (
            "Add real-time collaboration",
            "Integrate CRDT-based sync for concurrent editing",
            "todo",
            "medium",
            None,
            vec!["sync"],
            "Photon Core",
        ),
        (
            "Write API documentation",
            "Generate OpenAPI docs and add usage examples",
            "backlog",
            "low",
            None,
            vec!["docs"],
            "API Gateway",
        ),
    ];

    let seed_count = seeds.len();
    for (title, desc, status, priority, assignee, labels, project) in seeds {
        let id = Uuid::new_v4().to_string();
        let identifier = next_issue_identifier(pool).await?;
        let labels = serialize_labels(
            &labels
                .into_iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
        );
        let now = now_timestamp();
        sqlx::query(
            "INSERT INTO issues (id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&identifier)
        .bind(title)
        .bind(desc)
        .bind(status)
        .bind(priority)
        .bind(assignee)
        .bind(&labels)
        .bind(project)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    info!("Seeded {} issues", seed_count);
    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "photon_server=debug,tower_http=debug".into()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:photon.db?mode=rwc".into());

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    init_db(&pool).await?;
    seed_if_empty(&pool).await?;

    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
    let (presence_tx, _) = broadcast::channel::<String>(256);

    let state = Arc::new(AppState {
        db: pool,
        doc: RwLock::new(Doc::new()),
        broadcast_tx,
        presence_tx,
        active_connections: AtomicUsize::new(0),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        // Health
        .route("/api/health", get(health))
        // Issues CRUD
        .route("/api/issues", get(list_issues).post(create_issue))
        .route(
            "/api/issues/:id",
            get(get_issue).put(update_issue).delete(delete_issue),
        )
        // WebSocket
        .route("/ws", get(ws_handler))
        // Swagger UI
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        // Middleware
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let port = std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(3001);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Photon server listening on {addr}");
    info!("Swagger UI: http://{addr}/swagger-ui/");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn test_app() -> (Router, Arc<AppState>) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        init_db(&pool).await.unwrap();

        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let (presence_tx, _) = broadcast::channel::<String>(256);

        let state = Arc::new(AppState {
            db: pool,
            doc: RwLock::new(Doc::new()),
            broadcast_tx,
            presence_tx,
            active_connections: AtomicUsize::new(0),
        });

        let app = Router::new()
            .route("/api/health", get(health))
            .route("/api/issues", get(list_issues).post(create_issue))
            .route(
                "/api/issues/:id",
                get(get_issue).put(update_issue).delete(delete_issue),
            )
            .with_state(state.clone());

        (app, state)
    }

    #[tokio::test]
    async fn test_health() {
        let (app, _) = test_app().await;

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_create_and_list_issues() {
        let (app, _state) = test_app().await;

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/issues")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "title": "Test issue",
                            "description": "A test",
                            "labels": ["Feature", "sync"],
                            "project": "Photon Core"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::CREATED);

        // List
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/issues")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: IssueListResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(list.total, 1);
        assert_eq!(list.issues[0].title, "Test issue");
        assert!(list.issues[0].identifier.starts_with("PLT-"));
        assert_eq!(list.issues[0].labels, vec!["Feature", "sync"]);
        assert_eq!(list.issues[0].project, "Photon Core");
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let (app, _) = test_app().await;

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/issues/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_update_issue() {
        let (app, _) = test_app().await;

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/issues")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "title": "Original title",
                            "assignee": "Alice"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Issue = serde_json::from_slice(&body).unwrap();

        // Update
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(&format!("/api/issues/{}", created.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "title": "Updated title",
                            "status": "in_progress",
                            "assignee": null,
                            "labels": ["backend"],
                            "project": "API Gateway"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let updated: Issue = serde_json::from_slice(&body).unwrap();
        assert_eq!(updated.title, "Updated title");
        assert_eq!(updated.status, "in_progress");
        assert_eq!(updated.assignee, None);
        assert_eq!(updated.labels, vec!["backend"]);
        assert_eq!(updated.project, "API Gateway");
    }

    #[tokio::test]
    async fn test_delete_issue() {
        let (app, _) = test_app().await;

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/issues")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "title": "To delete" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Issue = serde_json::from_slice(&body).unwrap();

        // Delete
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(&format!("/api/issues/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // Verify gone
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(&format!("/api/issues/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
