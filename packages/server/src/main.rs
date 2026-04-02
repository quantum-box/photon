use std::{net::SocketAddr, sync::Arc};

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
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct Issue {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateIssue {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub assignee: Option<String>,
}

fn default_status() -> String {
    "backlog".into()
}
fn default_priority() -> String {
    "none".into()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateIssue {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
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

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub db: SqlitePool,
    pub doc: RwLock<Doc>,
    pub broadcast_tx: broadcast::Sender<Vec<u8>>,
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

    let issues = sqlx::query_as::<_, Issue>(
        "SELECT id, title, description, status, priority, assignee, created_at, updated_at
         FROM issues ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

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
    let issue = sqlx::query_as::<_, Issue>(
        "SELECT id, title, description, status, priority, assignee, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
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
    let now = chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S").to_string();

    sqlx::query(
        "INSERT INTO issues (id, title, description, status, priority, assignee, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(&payload.status)
    .bind(&payload.priority)
    .bind(&payload.assignee)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let issue = sqlx::query_as::<_, Issue>(
        "SELECT id, title, description, status, priority, assignee, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

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
    let existing = sqlx::query_as::<_, Issue>(
        "SELECT id, title, description, status, priority, assignee, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let title = payload.title.unwrap_or(existing.title);
    let description = payload.description.unwrap_or(existing.description);
    let status = payload.status.unwrap_or(existing.status);
    let priority = payload.priority.unwrap_or(existing.priority);
    let assignee = payload.assignee.or(existing.assignee);
    let now = chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S").to_string();

    sqlx::query(
        "UPDATE issues SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&title)
    .bind(&description)
    .bind(&status)
    .bind(&priority)
    .bind(&assignee)
    .bind(&now)
    .bind(&id)
    .execute(&state.db)
    .await?;

    let issue = sqlx::query_as::<_, Issue>(
        "SELECT id, title, description, status, priority, assignee, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

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

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

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
        return;
    }

    // Subscribe to broadcast channel for updates from other clients
    let mut broadcast_rx = state.broadcast_tx.subscribe();

    // Task: forward broadcast messages to this client's WebSocket
    let send_task = tokio::spawn(async move {
        while let Ok(data) = broadcast_rx.recv().await {
            if ws_sender.send(Message::Binary(data)).await.is_err() {
                break;
            }
        }
    });

    // Task: receive updates from this client, apply to doc, broadcast
    let recv_state = state.clone();
    let recv_task = tokio::spawn(async move {
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
        _ = send_task => {},
        _ = recv_task => {},
    }
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
        ("Set up project repository", "Initialize the monorepo structure with frontend and backend packages", "done", "urgent", Some("Alice")),
        ("Design database schema", "Define tables for issues, users, and projects", "done", "high", Some("Bob")),
        ("Implement authentication", "Add JWT-based auth with login/register endpoints", "in_progress", "urgent", Some("Alice")),
        ("Build issue list view", "Create the main table view for browsing issues", "in_progress", "high", Some("Charlie")),
        ("Add real-time collaboration", "Integrate CRDT-based sync for concurrent editing", "todo", "medium", None),
        ("Write API documentation", "Generate OpenAPI docs and add usage examples", "backlog", "low", None),
    ];

    let seed_count = seeds.len();
    for (title, desc, status, priority, assignee) in seeds {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now()
            .naive_utc()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        sqlx::query(
            "INSERT INTO issues (id, title, description, status, priority, assignee, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(title)
        .bind(desc)
        .bind(status)
        .bind(priority)
        .bind(assignee)
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

    let state = Arc::new(AppState {
        db: pool,
        doc: RwLock::new(Doc::new()),
        broadcast_tx,
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

    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
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

        let state = Arc::new(AppState {
            db: pool,
            doc: RwLock::new(Doc::new()),
            broadcast_tx,
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
                            "description": "A test"
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
                            "title": "Original title"
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
                            "status": "in_progress"
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
