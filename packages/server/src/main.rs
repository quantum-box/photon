use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
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

const DEFAULT_ROOM_ID: &str = "default";
/// Compact the on-disk update log when it grows beyond this many rows.
const YJS_COMPACTION_THRESHOLD: i64 = 100;

pub struct AppState {
    pub db: SqlitePool,
    pub doc: RwLock<Doc>,
    pub broadcast_tx: broadcast::Sender<Vec<u8>>,
    pub presence_tx: broadcast::Sender<String>,
    pub active_connections: AtomicUsize,
    pub room_id: String,
    pub next_seq: AtomicI64,
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

    // Task: receive updates from this client, apply to doc, persist, broadcast
    let recv_state = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => match apply_and_persist_update(&recv_state, &data).await {
                    Ok(true) => {
                        let _ = recv_state.broadcast_tx.send(data.to_vec());
                    }
                    Ok(false) => {
                        // Malformed update; logged inside apply_and_persist_update.
                    }
                    Err(err) => {
                        tracing::error!(error = %err, "Failed to persist yjs update");
                    }
                },
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
    sqlx::raw_sql(include_str!("../migrations/001_create_issues.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/002_create_yjs_state.sql"))
        .execute(pool)
        .await?;
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

// ---------------------------------------------------------------------------
// Yjs persistence — snapshot + update log + replay
// ---------------------------------------------------------------------------

/// Loads the persisted Y.Doc state for `room_id` from SQLite. Applies the
/// snapshot first (if any), then replays updates with `seq > snapshot_seq`
/// in order. Corrupt rows (un-decodeable bytes or apply-time errors) are
/// skipped with a warning so a single bad row can't poison the room.
///
/// Returns the hydrated `Doc` and the highest seq observed in the log
/// (or the snapshot's seq if the log is empty), which seeds `next_seq`.
async fn hydrate_yjs_doc(pool: &SqlitePool, room_id: &str) -> Result<(Doc, i64), sqlx::Error> {
    let doc = Doc::new();

    let snapshot_row: Option<(Vec<u8>, i64)> =
        sqlx::query_as("SELECT snapshot, snapshot_seq FROM yjs_snapshots WHERE room_id = ?")
            .bind(room_id)
            .fetch_optional(pool)
            .await?;

    let snapshot_seq = if let Some((bytes, seq)) = snapshot_row {
        match Update::decode_v1(&bytes) {
            Ok(update) => {
                let mut txn = doc.transact_mut();
                if let Err(err) = txn.apply_update(update) {
                    tracing::warn!(
                        room = room_id,
                        seq,
                        error = %err,
                        "Failed to apply yjs snapshot; starting from empty doc"
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    room = room_id,
                    seq,
                    error = %err,
                    "Corrupt yjs snapshot; starting from empty doc"
                );
            }
        }
        seq
    } else {
        0
    };

    let updates: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, update_bytes FROM yjs_updates WHERE room_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .bind(room_id)
    .bind(snapshot_seq)
    .fetch_all(pool)
    .await?;

    let mut max_seq = snapshot_seq;
    let mut applied = 0usize;
    let mut skipped = 0usize;
    for (seq, bytes) in updates {
        if seq > max_seq {
            max_seq = seq;
        }
        match Update::decode_v1(&bytes) {
            Ok(update) => {
                let mut txn = doc.transact_mut();
                match txn.apply_update(update) {
                    Ok(_) => applied += 1,
                    Err(err) => {
                        tracing::warn!(
                            room = room_id,
                            seq,
                            error = %err,
                            "Skipping un-applyable yjs update"
                        );
                        skipped += 1;
                    }
                }
            }
            Err(err) => {
                tracing::warn!(
                    room = room_id,
                    seq,
                    error = %err,
                    "Skipping un-decodable yjs update"
                );
                skipped += 1;
            }
        }
    }

    info!(
        room = room_id,
        snapshot_seq, max_seq, applied, skipped, "Hydrated yjs room from persisted state"
    );

    Ok((doc, max_seq))
}

/// Apply a validated update to the in-memory doc, persist it to the log
/// with a monotonic seq, and trigger compaction if the log has grown past
/// the threshold. Holds the doc write lock for the entire critical section
/// so that `compact_yjs_log` always sees a doc state that matches the DB.
///
/// Returns `Ok(true)` if the update was applied + persisted (caller should
/// broadcast); `Ok(false)` if the update was malformed and dropped.
async fn apply_and_persist_update(
    state: &Arc<AppState>,
    update_bytes: &[u8],
) -> Result<bool, sqlx::Error> {
    // Decode + apply happens entirely inside this sync block. yrs values
    // (Update, TransactionMut, Doc write guard) are NOT Send and cannot be
    // held across an await; confining them to a non-await scope keeps the
    // outer future Send so it can be tokio::spawn'd.
    let applied = {
        let doc_guard = state.doc.write().await;
        let decoded = match Update::decode_v1(update_bytes) {
            Ok(update) => update,
            Err(err) => {
                tracing::warn!(
                    room = %state.room_id,
                    error = %err,
                    bytes = update_bytes.len(),
                    "Dropping un-decodable yjs update from client"
                );
                return Ok(false);
            }
        };
        let mut txn = doc_guard.transact_mut();
        match txn.apply_update(decoded) {
            Ok(_) => true,
            Err(err) => {
                tracing::warn!(
                    room = %state.room_id,
                    error = %err,
                    "Dropping un-applyable yjs update from client"
                );
                false
            }
        }
    };
    if !applied {
        return Ok(false);
    }

    let seq = state.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let now = now_timestamp();

    sqlx::query(
        "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&state.room_id)
    .bind(seq)
    .bind(update_bytes)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let log_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_updates WHERE room_id = ?")
        .bind(&state.room_id)
        .fetch_one(&state.db)
        .await?;

    if log_count.0 > YJS_COMPACTION_THRESHOLD {
        compact_yjs_log(state).await?;
    }

    Ok(true)
}

/// Materialize the current doc as a snapshot, persist it transactionally
/// alongside deleting the rolled-up update rows. The boundary is captured
/// from the in-memory `next_seq` atomic *while still holding the doc read
/// lock*, so it can never exceed the seqs whose applies are reflected in
/// the snapshot. (Reading MAX(seq) from the DB after releasing the lock
/// would race with a concurrent writer that already inserted its row but
/// whose apply wasn't in the captured snapshot — that scenario would
/// silently delete the writer's row.) Boundary may legitimately under-
/// count if a writer is between releasing the write lock and its
/// `fetch_add`; the orphan log row is harmless because yrs apply is
/// idempotent on rehydrate.
async fn compact_yjs_log(state: &Arc<AppState>) -> Result<(), sqlx::Error> {
    let (snapshot_bytes, boundary_seq) = {
        let doc_guard = state.doc.read().await;
        let txn = doc_guard.transact();
        let bytes = txn.encode_state_as_update_v1(&StateVector::default());
        let seq = state.next_seq.load(Ordering::SeqCst);
        (bytes, seq)
    };

    if boundary_seq <= 0 {
        return Ok(());
    }

    let now = now_timestamp();
    let snapshot_len = snapshot_bytes.len();
    let mut tx = state.db.begin().await?;

    sqlx::query(
        "INSERT INTO yjs_snapshots (room_id, snapshot, snapshot_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
             snapshot = excluded.snapshot,
             snapshot_seq = excluded.snapshot_seq,
             updated_at = excluded.updated_at",
    )
    .bind(&state.room_id)
    .bind(&snapshot_bytes)
    .bind(boundary_seq)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM yjs_updates WHERE room_id = ? AND seq <= ?")
        .bind(&state.room_id)
        .bind(boundary_seq)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    info!(
        room = %state.room_id,
        boundary_seq,
        snapshot_bytes = snapshot_len,
        "Compacted yjs update log into snapshot"
    );
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

    let room_id = DEFAULT_ROOM_ID.to_string();
    let (doc, max_seq) = hydrate_yjs_doc(&pool, &room_id).await?;

    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
    let (presence_tx, _) = broadcast::channel::<String>(256);

    let state = Arc::new(AppState {
        db: pool,
        doc: RwLock::new(doc),
        broadcast_tx,
        presence_tx,
        active_connections: AtomicUsize::new(0),
        room_id,
        next_seq: AtomicI64::new(max_seq),
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
            room_id: DEFAULT_ROOM_ID.to_string(),
            next_seq: AtomicI64::new(0),
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

    // -----------------------------------------------------------------------
    // Yjs persistence + replay tests
    // -----------------------------------------------------------------------

    use yrs::Map;

    fn make_test_state(pool: SqlitePool) -> Arc<AppState> {
        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let (presence_tx, _) = broadcast::channel::<String>(256);
        Arc::new(AppState {
            db: pool,
            doc: RwLock::new(Doc::new()),
            broadcast_tx,
            presence_tx,
            active_connections: AtomicUsize::new(0),
            room_id: DEFAULT_ROOM_ID.to_string(),
            next_seq: AtomicI64::new(0),
        })
    }

    async fn yjs_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        pool
    }

    /// Generate an update from a fresh source doc that sets a key on the
    /// shared "issues" map, returning the update bytes.
    fn build_update_setting_key(key: &str, value: &str) -> Vec<u8> {
        let source = Doc::new();
        let map = source.get_or_insert_map("issues");
        let initial_state = source.transact().state_vector();
        {
            let mut txn = source.transact_mut();
            map.insert(&mut txn, key, value);
        }
        let txn = source.transact();
        txn.encode_state_as_update_v1(&initial_state)
    }

    fn read_map_string(doc: &Doc, key: &str) -> Option<String> {
        let map = doc.get_or_insert_map("issues");
        let txn = doc.transact();
        map.get(&txn, key).and_then(|v| v.cast::<String>().ok())
    }

    #[tokio::test]
    async fn test_apply_and_persist_round_trip() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        let update = build_update_setting_key("a", "alpha");
        let applied = apply_and_persist_update(&state, &update).await.unwrap();
        assert!(applied);
        assert_eq!(state.next_seq.load(Ordering::SeqCst), 1);

        // Hydrate a fresh doc from the same DB and confirm state survived.
        let (reloaded, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 1);
        assert_eq!(read_map_string(&reloaded, "a"), Some("alpha".into()));
    }

    #[tokio::test]
    async fn test_corrupt_update_skipped_on_replay() {
        let pool = yjs_test_pool().await;

        // One good update at seq=1, one corrupt blob at seq=2, one good at seq=3.
        let good_one = build_update_setting_key("k1", "v1");
        let good_two = build_update_setting_key("k2", "v2");
        let now = now_timestamp();

        for (seq, bytes) in [(1i64, good_one), (2, vec![0xFFu8; 8]), (3, good_two)] {
            sqlx::query(
                "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
            )
            .bind(DEFAULT_ROOM_ID)
            .bind(seq)
            .bind(&bytes)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        }

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 3, "max seq must include the corrupt row's seq");
        assert_eq!(read_map_string(&doc, "k1"), Some("v1".into()));
        assert_eq!(read_map_string(&doc, "k2"), Some("v2".into()));
    }

    #[tokio::test]
    async fn test_apply_rejects_garbage_bytes() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        let garbage = vec![0xFFu8; 32];
        let applied = apply_and_persist_update(&state, &garbage).await.unwrap();
        assert!(!applied, "garbage bytes should be dropped, not persisted");
        assert_eq!(state.next_seq.load(Ordering::SeqCst), 0);

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_updates")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn test_compaction_collapses_log_into_snapshot() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        // Push enough updates to cross the compaction threshold.
        let total = (YJS_COMPACTION_THRESHOLD as usize) + 5;
        for i in 0..total {
            let update = build_update_setting_key(&format!("k{i}"), &format!("v{i}"));
            apply_and_persist_update(&state, &update).await.unwrap();
        }

        let log_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_updates")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            log_count.0 <= YJS_COMPACTION_THRESHOLD,
            "log should be compacted: rows={}",
            log_count.0
        );

        let snapshot_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(snapshot_count.0, 1, "exactly one snapshot row expected");

        // Hydrate from disk and verify all values survived compaction.
        let (reloaded, _) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        for i in 0..total {
            assert_eq!(
                read_map_string(&reloaded, &format!("k{i}")),
                Some(format!("v{i}")),
                "key k{i} missing after compaction + reload"
            );
        }
    }

    #[tokio::test]
    async fn test_hydrate_from_snapshot_and_replay() {
        let pool = yjs_test_pool().await;

        // Build a doc and store its full state as a snapshot at seq=10.
        let snap_doc = Doc::new();
        {
            let map = snap_doc.get_or_insert_map("issues");
            let mut txn = snap_doc.transact_mut();
            map.insert(&mut txn, "snap", "in-snapshot");
        }
        let snap_bytes = {
            let txn = snap_doc.transact();
            txn.encode_state_as_update_v1(&StateVector::default())
        };
        let now = now_timestamp();
        sqlx::query(
            "INSERT INTO yjs_snapshots (room_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(&snap_bytes)
        .bind(10i64)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // A post-snapshot update at seq=11 — should be replayed.
        let post = build_update_setting_key("post", "after-snapshot");
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(11i64)
        .bind(&post)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // A pre-snapshot orphan update at seq=5 — should be ignored by hydrate.
        let pre = build_update_setting_key("pre", "before-snapshot");
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(5i64)
        .bind(&pre)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 11);
        assert_eq!(read_map_string(&doc, "snap"), Some("in-snapshot".into()));
        assert_eq!(read_map_string(&doc, "post"), Some("after-snapshot".into()));
        assert_eq!(
            read_map_string(&doc, "pre"),
            None,
            "pre-snapshot update should not be replayed"
        );
    }

    /// Regression test for the race fix in `compact_yjs_log`. A row whose
    /// seq is past the in-memory `next_seq` boundary (i.e. its writer has
    /// already inserted but the compactor hasn't observed its `fetch_add`
    /// or the apply isn't in the captured snapshot) MUST survive
    /// compaction — otherwise the orphan apply is silently lost.
    #[tokio::test]
    async fn test_compaction_preserves_rows_past_next_seq_boundary() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        let real = build_update_setting_key("real", "yes");
        apply_and_persist_update(&state, &real).await.unwrap();
        assert_eq!(state.next_seq.load(Ordering::SeqCst), 1);

        // Simulate a writer that inserted its row but whose data is NOT
        // yet reflected in the doc snapshot from the compactor's view.
        // The old `SELECT MAX(seq)` boundary would treat seq=2 as in-scope
        // and delete it, losing the apply. With the new boundary captured
        // from `next_seq.load()` (=1), seq=2 is preserved.
        let pending = build_update_setting_key("pending", "preserved");
        let now = now_timestamp();
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(2i64)
        .bind(&pending)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        compact_yjs_log(&state).await.unwrap();

        let surviving: Vec<(i64,)> =
            sqlx::query_as("SELECT seq FROM yjs_updates WHERE room_id = ? ORDER BY seq")
                .bind(DEFAULT_ROOM_ID)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(
            surviving.iter().any(|(s,)| *s == 2),
            "compaction must not delete row at seq=2 (boundary should be next_seq=1), surviving: {:?}",
            surviving,
        );

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 2);
        assert_eq!(read_map_string(&doc, "real"), Some("yes".into()));
        assert_eq!(read_map_string(&doc, "pending"), Some("preserved".into()));
    }

    /// Stress test: many parallel writers + interleaved compactions must
    /// preserve every applied update on hydrate. Doesn't deterministically
    /// schedule the race but exercises the parallel paths under load.
    #[tokio::test]
    async fn test_parallel_writes_preserve_all_data() {
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        let state = make_test_state(pool.clone());

        let total = (YJS_COMPACTION_THRESHOLD as usize) * 2;
        let mut handles = Vec::with_capacity(total);
        for i in 0..total {
            let st = state.clone();
            handles.push(tokio::spawn(async move {
                let update = build_update_setting_key(&format!("k{i}"), &format!("v{i}"));
                apply_and_persist_update(&st, &update).await.unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let (doc, _) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        for i in 0..total {
            assert_eq!(
                read_map_string(&doc, &format!("k{i}")),
                Some(format!("v{i}")),
                "key k{i} missing after parallel writes + compaction",
            );
        }
    }

    #[tokio::test]
    async fn test_corrupt_snapshot_starts_fresh_and_replays_log() {
        let pool = yjs_test_pool().await;
        let now = now_timestamp();

        sqlx::query(
            "INSERT INTO yjs_snapshots (room_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(vec![0xDEu8, 0xAD, 0xBE, 0xEF])
        .bind(0i64)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let update = build_update_setting_key("survives", "yes");
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(1i64)
        .bind(&update)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 1);
        assert_eq!(read_map_string(&doc, "survives"), Some("yes".into()));
    }
}
