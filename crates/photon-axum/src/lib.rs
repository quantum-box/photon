use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use photon_engine::{
    CollectionName, MySqlAdapter, Operation, OperationFilter, OperationKind, OperationStatus,
    PhotonEngine, PullRequest, PullResult, PulledOperation, PushDecision, PushRequest, PushResult,
    Record, RecordId, RecordKey, RemoteId, ScopeId, Snapshot, SnapshotUpdate, SqliteAdapter,
    StorageAdapter, StoredOperation, SyncCursor,
};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tracing::{info, warn};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use yrs::{updates::decoder::Decode, Doc, ReadTxn, StateVector, Transact, Update};

mod auth;
mod policy;

use auth::bearer_token;
pub use auth::{parse_workspace_scope, AuthConfig, AuthError, TokenGrant, WorkspaceScope};
pub use policy::{AllowAllPolicy, EnginePolicy, OperationContext, PolicyVerdict};

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

#[derive(OpenApi)]
#[openapi(
    paths(health, engine_debug_state),
    components(schemas(
        HealthResponse,
        EngineDebugState,
        EngineOperationCounts,
        EngineCollectionDebugState,
        EngineRecentOperation,
    )),
    info(
        title = "Photon Engine API",
        version = "0.1.0",
        description = "Photon Engine sync API — durable operation push/pull"
    )
)]
struct ApiDoc;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub tenant_id: Option<String>,
    pub workspace_id: Option<String>,
    pub surface_type: Option<String>,
    pub surface_id: Option<String>,
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
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

const DEFAULT_WORKSPACE_ID: &str = "photon-default";
const DEFAULT_TENANT_ID: &str = "photon";
const ENGINE_ACTOR_ID: &str = "photon-server";
const ENGINE_YJS_COLLECTION: &str = "yjs_documents";
const ENGINE_YJS_UPDATE_FORMAT: &str = "yjs-update-v1";
const ENGINE_YJS_SNAPSHOT_FORMAT: &str = "yjs-state-v1";

fn engine_error_to_sqlx(error: photon_engine::EngineError) -> sqlx::Error {
    sqlx::Error::Protocol(error.to_string())
}

fn default_workspace_scope() -> ScopeId {
    workspace_scope(DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID)
}

fn workspace_scope(tenant_id: &str, workspace_id: &str) -> ScopeId {
    ScopeId::from(format!("tenant:{tenant_id}:workspace:{workspace_id}"))
}

fn normalized_tenant_id(value: Option<String>) -> String {
    normalize_optional_text(value).unwrap_or_else(|| DEFAULT_TENANT_ID.into())
}

fn normalized_workspace_id(value: Option<String>) -> String {
    normalize_optional_text(value).unwrap_or_else(|| DEFAULT_WORKSPACE_ID.into())
}

fn engine_record_key_for_scope(
    scope: impl Into<ScopeId>,
    collection: &str,
    record_id: &str,
) -> RecordKey {
    RecordKey::new(scope, CollectionName::from(collection), record_id)
}

fn engine_yjs_snapshot_key(scope: &ScopeId, room_id: &str) -> RecordKey {
    engine_record_key_for_scope(scope.clone(), ENGINE_YJS_COLLECTION, room_id)
}

/// Which tenant a Live room belongs to, and which Engine scope its Yjs
/// snapshots are stored under.
///
/// Rooms follow the `tenant:{tenant}:workspace:{workspace}:{surface}`
/// convention (see the playground's `buildRoomId`). A room named that way is
/// pinned to its tenant; anything else is treated as the default tenant, which
/// a tenant-confined token is never granted.
fn room_tenant_and_scope(room_id: &str) -> (String, ScopeId) {
    let mut parts = room_id.splitn(5, ':');
    if let (Some("tenant"), Some(tenant), Some("workspace"), Some(workspace)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    {
        if !tenant.is_empty() && !workspace.is_empty() {
            return (tenant.to_owned(), workspace_scope(tenant, workspace));
        }
    }
    (DEFAULT_TENANT_ID.to_owned(), default_workspace_scope())
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Default page size for `/api/engine/pull`.
const DEFAULT_PULL_LIMIT: usize = 200;
/// Hard ceiling, so a client cannot ask for the whole history in one response.
const MAX_PULL_LIMIT: usize = 1_000;

const DEFAULT_ROOM_ID: &str = "default";
/// Compact the on-disk update log when it grows beyond this many rows.
const YJS_COMPACTION_THRESHOLD: i64 = 100;

pub struct AppState {
    pub db: SqlitePool,
    pub engine: PhotonEngine<ServerEngineAdapter>,
    pub engine_next_seq: AtomicI64,
    /// Serializes remote-sequence assignment with the operation write.
    ///
    /// Without it two concurrent pushes can commit out of sequence order, and
    /// a pull issued in that window returns sequence N+1 while N is still
    /// uncommitted — the client's cursor then advances past N and never sees
    /// it. The op-log is the durable truth, so a permanently skipped
    /// operation is data loss on every other client.
    pub engine_push_lock: tokio::sync::Mutex<()>,
    pub rooms: RwLock<HashMap<String, Arc<RoomState>>>,
    pub auth: AuthConfig,
    /// Domain-level write authorization, consulted per pushed operation.
    pub policy: Arc<dyn EnginePolicy>,
}

pub struct RoomState {
    pub db: SqlitePool,
    pub engine: PhotonEngine<ServerEngineAdapter>,
    pub doc: RwLock<Doc>,
    pub broadcast_tx: broadcast::Sender<Vec<u8>>,
    pub presence_tx: broadcast::Sender<String>,
    pub active_connections: AtomicUsize,
    pub room_id: String,
    /// Tenant this room is pinned to, derived from the room id convention.
    pub tenant_id: String,
    /// Engine scope its Yjs snapshots and updates are stored under.
    pub engine_scope: ScopeId,
    pub next_seq: AtomicI64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineOperationCounts {
    pub pending: usize,
    pub accepted: usize,
    pub rejected: usize,
    pub conflict: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineCollectionDebugState {
    pub collection: String,
    pub records: usize,
    pub operations: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineRecentOperation {
    pub operation_id: String,
    pub collection: String,
    pub record_id: String,
    pub actor_id: String,
    pub kind: String,
    pub status: String,
    pub local_sequence: i64,
    pub remote_sequence: Option<i64>,
    pub received_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineDebugState {
    pub role: String,
    pub scope: String,
    pub remote: String,
    pub next_remote_sequence: i64,
    pub cursor_position: Option<i64>,
    pub counts: EngineOperationCounts,
    pub collections: Vec<EngineCollectionDebugState>,
    pub recent_operations: Vec<EngineRecentOperation>,
}

#[derive(Clone, Debug)]
pub enum ServerEngineAdapter {
    Sqlite(SqliteAdapter),
    MySql(MySqlAdapter),
}

#[async_trait]
impl StorageAdapter for ServerEngineAdapter {
    async fn append_operation(
        &self,
        operation: Operation,
        status: OperationStatus,
    ) -> photon_engine::Result<StoredOperation> {
        match self {
            Self::Sqlite(adapter) => adapter.append_operation(operation, status).await,
            Self::MySql(adapter) => adapter.append_operation(operation, status).await,
        }
    }

    async fn get_operation(
        &self,
        operation_id: &photon_engine::OperationId,
    ) -> photon_engine::Result<Option<StoredOperation>> {
        match self {
            Self::Sqlite(adapter) => adapter.get_operation(operation_id).await,
            Self::MySql(adapter) => adapter.get_operation(operation_id).await,
        }
    }

    async fn mark_operation_status(
        &self,
        operation_id: &photon_engine::OperationId,
        status: OperationStatus,
        remote_sequence: Option<i64>,
    ) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => {
                adapter
                    .mark_operation_status(operation_id, status, remote_sequence)
                    .await
            }
            Self::MySql(adapter) => {
                adapter
                    .mark_operation_status(operation_id, status, remote_sequence)
                    .await
            }
        }
    }

    async fn list_operations(
        &self,
        filter: OperationFilter,
    ) -> photon_engine::Result<Vec<StoredOperation>> {
        match self {
            Self::Sqlite(adapter) => adapter.list_operations(filter).await,
            Self::MySql(adapter) => adapter.list_operations(filter).await,
        }
    }

    async fn upsert_record(&self, record: Record) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.upsert_record(record).await,
            Self::MySql(adapter) => adapter.upsert_record(record).await,
        }
    }

    async fn get_record(&self, key: &RecordKey) -> photon_engine::Result<Option<Record>> {
        match self {
            Self::Sqlite(adapter) => adapter.get_record(key).await,
            Self::MySql(adapter) => adapter.get_record(key).await,
        }
    }

    async fn list_records(
        &self,
        scope: &ScopeId,
        collection: &CollectionName,
    ) -> photon_engine::Result<Vec<Record>> {
        match self {
            Self::Sqlite(adapter) => adapter.list_records(scope, collection).await,
            Self::MySql(adapter) => adapter.list_records(scope, collection).await,
        }
    }

    async fn delete_record_projection(&self, key: &RecordKey) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.delete_record_projection(key).await,
            Self::MySql(adapter) => adapter.delete_record_projection(key).await,
        }
    }

    async fn save_snapshot(&self, snapshot: Snapshot) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.save_snapshot(snapshot).await,
            Self::MySql(adapter) => adapter.save_snapshot(snapshot).await,
        }
    }

    async fn get_snapshot(&self, key: &RecordKey) -> photon_engine::Result<Option<Snapshot>> {
        match self {
            Self::Sqlite(adapter) => adapter.get_snapshot(key).await,
            Self::MySql(adapter) => adapter.get_snapshot(key).await,
        }
    }

    async fn append_snapshot_update(&self, update: SnapshotUpdate) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.append_snapshot_update(update).await,
            Self::MySql(adapter) => adapter.append_snapshot_update(update).await,
        }
    }

    async fn list_snapshot_updates(
        &self,
        key: &RecordKey,
        after_sequence: i64,
    ) -> photon_engine::Result<Vec<SnapshotUpdate>> {
        match self {
            Self::Sqlite(adapter) => adapter.list_snapshot_updates(key, after_sequence).await,
            Self::MySql(adapter) => adapter.list_snapshot_updates(key, after_sequence).await,
        }
    }

    async fn compact_snapshot_updates(
        &self,
        key: &RecordKey,
        up_to_sequence: i64,
    ) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.compact_snapshot_updates(key, up_to_sequence).await,
            Self::MySql(adapter) => adapter.compact_snapshot_updates(key, up_to_sequence).await,
        }
    }

    async fn save_cursor(&self, cursor: SyncCursor) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.save_cursor(cursor).await,
            Self::MySql(adapter) => adapter.save_cursor(cursor).await,
        }
    }

    async fn get_cursor(
        &self,
        scope: &ScopeId,
        remote: &RemoteId,
    ) -> photon_engine::Result<Option<SyncCursor>> {
        match self {
            Self::Sqlite(adapter) => adapter.get_cursor(scope, remote).await,
            Self::MySql(adapter) => adapter.get_cursor(scope, remote).await,
        }
    }

    async fn save_conflict(&self, conflict: photon_engine::Conflict) -> photon_engine::Result<()> {
        match self {
            Self::Sqlite(adapter) => adapter.save_conflict(conflict).await,
            Self::MySql(adapter) => adapter.save_conflict(conflict).await,
        }
    }

    async fn list_conflicts(
        &self,
        scope: &ScopeId,
        collection: Option<&CollectionName>,
        record_id: Option<&RecordId>,
    ) -> photon_engine::Result<Vec<photon_engine::Conflict>> {
        match self {
            Self::Sqlite(adapter) => adapter.list_conflicts(scope, collection, record_id).await,
            Self::MySql(adapter) => adapter.list_conflicts(scope, collection, record_id).await,
        }
    }
}

/// Engine sync routes, without state or middleware.
///
/// Use this when the host application supplies its own layers; otherwise reach
/// for [`engine_router`], which is the batteries-included form.
pub fn engine_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/engine/push",
            axum::routing::post(push_engine_operations),
        )
        .route(
            "/api/engine/pull",
            axum::routing::post(pull_engine_operations),
        )
        .route("/api/engine/debug", get(engine_debug_state))
}

/// Photon Live WebSocket route, without state or middleware.
pub fn live_routes() -> Router<Arc<AppState>> {
    Router::new().route("/ws", get(ws_handler))
}

/// Engine sync API: `/api/health`, `/api/engine/{push,pull,debug}` and Swagger UI.
///
/// Ready to `.merge()` into an existing axum application.
pub fn engine_router(state: Arc<AppState>) -> Router {
    engine_routes()
        .merge(swagger_ui())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors_layer())
        .with_state(state)
}

/// Photon Live realtime relay: `/ws`.
pub fn live_router(state: Arc<AppState>) -> Router {
    live_routes()
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors_layer())
        .with_state(state)
}

/// Engine sync API and Live relay behind one shared middleware stack.
pub fn combined_router(state: Arc<AppState>) -> Router {
    engine_routes()
        .merge(live_routes())
        .merge(swagger_ui())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors_layer())
        .with_state(state)
}

fn swagger_ui() -> SwaggerUi {
    SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi())
}

pub fn normalize_engine_database_url(engine_database_url: &str) -> String {
    MySqlAdapter::normalize_database_url(engine_database_url)
}

pub fn engine_database_kind(engine_database_url: &str) -> &'static str {
    if engine_database_url.starts_with("tidb://") {
        "tidb"
    } else if engine_database_url.starts_with("mysql://") {
        "mysql"
    } else {
        "sqlite"
    }
}

pub async fn build_state(
    database_url: &str,
    engine_database_url: &str,
) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    let auth = AuthConfig::from_env()?;
    build_state_with_auth(database_url, engine_database_url, auth).await
}

pub async fn build_state_with_auth(
    database_url: &str,
    engine_database_url: &str,
    auth: AuthConfig,
) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    build_state_with_auth_and_policy(
        database_url,
        engine_database_url,
        auth,
        Arc::new(AllowAllPolicy),
    )
    .await
}

/// [`build_state_with_auth`] plus a host-supplied [`EnginePolicy`] for
/// domain-level write authorization.
pub async fn build_state_with_auth_and_policy(
    database_url: &str,
    engine_database_url: &str,
    auth: AuthConfig,
    policy: Arc<dyn EnginePolicy>,
) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;

    init_db(&pool).await?;
    let engine = init_engine(&pool, engine_database_url).await?;
    verify_engine_startup(&engine, engine_database_url).await?;
    let engine_next_seq = init_engine_next_sequence(&engine).await?;

    if auth.is_enabled() {
        info!("Photon auth boundary enabled: bearer tokens required");
    } else {
        warn!(
            "Photon auth boundary DISABLED (PHOTON_AUTH_TOKENS is unset). \
             Every caller can read and write every tenant. Local development only."
        );
    }

    Ok(Arc::new(AppState {
        db: pool,
        engine,
        engine_next_seq: AtomicI64::new(engine_next_seq),
        engine_push_lock: tokio::sync::Mutex::new(()),
        rooms: RwLock::new(HashMap::new()),
        auth,
        policy,
    }))
}

/// CORS from `PHOTON_CORS_ALLOWED_ORIGINS` (comma-separated exact origins).
///
/// Unset or `*` allows any origin — acceptable because authorization is
/// carried by bearer tokens, never cookies, so a cross-origin request gains
/// nothing without a token. Deployments that want the extra fence set the
/// variable anyway.
fn cors_layer() -> CorsLayer {
    let origins = std::env::var("PHOTON_CORS_ALLOWED_ORIGINS").ok();
    let allow_origin = match origins.as_deref().map(str::trim) {
        None | Some("") | Some("*") => AllowOrigin::any(),
        Some(list) => AllowOrigin::list(
            list.split(',')
                .filter_map(|origin| origin.trim().parse().ok()),
        ),
    };
    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods(Any)
        .allow_headers(Any)
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

/// The shared entry check for every scoped Engine request: a trusted bearer
/// token, a well-formed workspace scope, and a token grant that covers the
/// scope's tenant. Returns the parsed scope so handlers can use the tenant.
fn authorize_scoped_request(
    state: &AppState,
    headers: &HeaderMap,
    scope: &ScopeId,
) -> Result<(TokenGrant, WorkspaceScope), AppError> {
    let grant = state.auth.authorize(bearer_token(headers))?;
    let workspace = parse_workspace_scope(scope).ok_or_else(|| {
        AppError::BadRequest(format!(
            "scope must be tenant:{{tenant}}:workspace:{{workspace}}, got {scope:?}"
        ))
    })?;
    if !grant.allows_tenant(&workspace.tenant_id) {
        return Err(AppError::Forbidden(
            "token is not granted access to this tenant",
        ));
    }
    Ok((grant, workspace))
}

/// The key under which the server records audit metadata on an accepted
/// operation. Stored inside `Operation::metadata`, so it is durable in the
/// same row as the operation itself and travels with every pull.
const AUDIT_METADATA_KEY: &str = "photon_audit";

/// Stamp who was authorized to push this operation, and under which request.
///
/// `Operation::metadata` is the designed slot for out-of-band annotations: it
/// does not participate in projection, so stamping it cannot change what any
/// client renders. Existing metadata keys are preserved; a non-object
/// metadata value is left untouched rather than destroyed.
fn stamp_audit_metadata(
    operation: &mut Operation,
    grant: &TokenGrant,
    request_id: &str,
    received_at_ms: i64,
) {
    let audit = match grant {
        TokenGrant::AllTenants => serde_json::json!({
            "authorized": "service",
            "request_id": request_id,
            "received_at_ms": received_at_ms,
        }),
        TokenGrant::Tenant(tenant_id) => serde_json::json!({
            "authorized": "tenant",
            "tenant_id": tenant_id,
            "request_id": request_id,
            "received_at_ms": received_at_ms,
        }),
    };

    match &mut operation.metadata {
        serde_json::Value::Null => {
            operation.metadata = serde_json::json!({ AUDIT_METADATA_KEY: audit });
        }
        serde_json::Value::Object(existing) => {
            existing.insert(AUDIT_METADATA_KEY.to_owned(), audit);
        }
        _ => {}
    }
}

async fn push_engine_operations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<PushRequest>,
) -> Result<Json<PushResult>, AppError> {
    let request_id = headers
        .get("x-photon-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none");
    let (grant, workspace) = authorize_scoped_request(&state, &headers, &payload.scope)?;
    let scope = payload.scope.clone();
    let operation_count = payload.operations.len();
    let mut decisions = Vec::with_capacity(payload.operations.len());
    let mut accepted_count = 0usize;
    let mut rejected_count = 0usize;
    let mut max_remote_sequence = 0;

    // An operation whose own key disagrees with the request scope is how a
    // caller would smuggle a write into a workspace the scope check never saw.
    // The batch is rejected whole: decisions are per-operation verdicts, not a
    // way to accept half of an inconsistent request.
    if let Some(operation) = payload
        .operations
        .iter()
        .find(|operation| operation.key.scope != scope)
    {
        return Err(AppError::BadRequest(format!(
            "operation {} is scoped to {:?} but the request is scoped to {:?}",
            operation.id, operation.key.scope, scope
        )));
    }

    for mut operation in payload.operations {
        // The host's domain rules get the final say, one operation at a time.
        // A rejection is a decision, not an error: the rest of the batch still
        // lands, and the client rolls this one back by replay.
        let verdict = state
            .policy
            .authorize_operation(OperationContext {
                grant: &grant,
                workspace: &workspace,
                operation: &operation,
            })
            .await;
        if let PolicyVerdict::Reject { reason } = verdict {
            rejected_count += 1;
            decisions.push(PushDecision::Rejected {
                operation_id: operation.id,
                reason,
            });
            continue;
        }

        stamp_audit_metadata(
            &mut operation,
            &grant,
            request_id,
            chrono::Utc::now().timestamp_millis(),
        );

        // Assign and commit under one lock: commit order must equal sequence
        // order, or a concurrent pull skips the not-yet-committed sequence
        // forever (see `engine_push_lock`).
        let remote_sequence = {
            let _guard = state.engine_push_lock.lock().await;
            let remote_sequence = state.engine_next_seq.fetch_add(1, Ordering::SeqCst) + 1;
            state
                .engine
                .apply_remote_operation(operation.clone(), remote_sequence)
                .await?;
            remote_sequence
        };
        accepted_count += 1;
        decisions.push(PushDecision::Accepted {
            operation_id: operation.id,
            remote_sequence,
        });
        max_remote_sequence = max_remote_sequence.max(remote_sequence);
    }

    let cursor = if max_remote_sequence > 0 {
        Some(SyncCursor::new(
            payload.scope,
            RemoteId::from(ENGINE_ACTOR_ID),
            max_remote_sequence,
        ))
    } else {
        payload.cursor
    };

    info!(
        request_id,
        scope = %scope,
        operation_count,
        accepted = accepted_count,
        rejected = rejected_count,
        max_remote_sequence,
        "Photon Engine push processed operations",
    );

    // Wake up other clients' Engine sync loops right away instead of leaving
    // them to their poll interval. Only rooms of the pushing tenant are told:
    // a change-notification frame is cheap, but it still must not leak the
    // fact that another tenant's data changed.
    if accepted_count > 0 {
        broadcast_engine_changed(&state, &workspace.tenant_id, max_remote_sequence).await;
    }

    Ok(Json(PushResult {
        decisions,
        server_operations: Vec::new(),
        cursor,
    }))
}

/// Text frame sent over Photon Live sockets when the Engine op-log advanced.
///
/// The payload is a pull hint, nothing more: the cursor lets a client skip the
/// pull when it has already caught up, but the operations themselves only ever
/// travel over the Engine pull endpoint. Live never carries durable truth.
fn engine_changed_frame(cursor: i64) -> String {
    format!(r#"{{"type":"engine-changed","cursor":{cursor}}}"#)
}

async fn broadcast_engine_changed(state: &AppState, tenant_id: &str, cursor: i64) {
    let frame = engine_changed_frame(cursor);
    for room in state.rooms.read().await.values() {
        if room.tenant_id != tenant_id {
            continue;
        }
        // Send fails only when a room has no subscribers, which is fine.
        let _ = room.presence_tx.send(frame.clone());
    }
}

async fn pull_engine_operations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<PullRequest>,
) -> Result<Json<PullResult>, AppError> {
    let request_id = headers
        .get("x-photon-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none");
    authorize_scoped_request(&state, &headers, &payload.scope)?;
    let scope = payload.scope.clone();
    let after_remote_sequence = payload.cursor.as_ref().map(|cursor| cursor.position);
    // Bound the response. An unbounded pull loads the entire operation history
    // of a workspace into memory and into one HTTP body.
    let limit = payload
        .limit
        .filter(|limit| *limit > 0)
        .map_or(DEFAULT_PULL_LIMIT, |limit| limit.min(MAX_PULL_LIMIT));
    let operations = state
        .engine
        .storage()
        .list_operations(OperationFilter {
            scope: Some(payload.scope.clone()),
            status: Some(OperationStatus::Accepted),
            after_remote_sequence,
            limit: Some(limit),
            ..OperationFilter::default()
        })
        .await?;
    let fetched_count = operations.len();

    let mut max_remote_sequence = payload
        .cursor
        .as_ref()
        .map(|cursor| cursor.position)
        .unwrap_or_default();
    let pulled: Vec<_> = operations
        .into_iter()
        .filter_map(|stored| {
            stored.remote_sequence.map(|remote_sequence| {
                max_remote_sequence = max_remote_sequence.max(remote_sequence);
                PulledOperation {
                    operation: stored.operation,
                    remote_sequence,
                }
            })
        })
        .collect();
    let pulled_count = pulled.len();

    info!(
        request_id,
        scope = %scope,
        after_remote_sequence,
        pulled_count,
        max_remote_sequence,
        "Photon Engine pull returned operations",
    );

    Ok(Json(PullResult {
        // A full page means there is very likely another one behind it.
        // Counted before the remote-sequence filter: one legacy accepted row
        // without a sequence must not end paging for everything behind it.
        has_more: fetched_count >= limit,
        operations: pulled,
        cursor: Some(SyncCursor::new(
            payload.scope,
            RemoteId::from(ENGINE_ACTOR_ID),
            max_remote_sequence,
        )),
    }))
}

fn operation_kind_label(kind: &OperationKind) -> &'static str {
    match kind {
        OperationKind::Upsert { .. } => "upsert",
        OperationKind::Patch { .. } => "patch",
        OperationKind::RemoveFields { .. } => "remove_fields",
        OperationKind::Delete => "delete",
        OperationKind::Restore { .. } => "restore",
        OperationKind::Increment { .. } => "increment",
        OperationKind::SetAdd { .. } => "set_add",
        OperationKind::SetRemove { .. } => "set_remove",
    }
}

fn count_status(counts: &mut EngineOperationCounts, status: &OperationStatus) {
    match status {
        OperationStatus::Pending => counts.pending += 1,
        OperationStatus::Accepted => counts.accepted += 1,
        OperationStatus::Rejected => counts.rejected += 1,
        OperationStatus::Conflict => counts.conflict += 1,
    }
    counts.total += 1;
}

#[utoipa::path(
    get,
    path = "/api/engine/debug",
    responses(
        (status = 200, description = "Photon Engine sync debug state", body = EngineDebugState)
    ),
    tag = "engine"
)]
async fn engine_debug_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<Json<EngineDebugState>, AppError> {
    let grant = state.auth.authorize(bearer_token(&headers))?;
    let tenant_id = normalized_tenant_id(params.tenant_id);
    if !grant.allows_tenant(&tenant_id) {
        return Err(AppError::Forbidden(
            "token is not granted access to this tenant",
        ));
    }
    let workspace_id = normalized_workspace_id(params.workspace_id);
    let scope = workspace_scope(&tenant_id, &workspace_id);
    let operations = state
        .engine
        .storage()
        .list_operations(OperationFilter {
            scope: Some(scope.clone()),
            ..OperationFilter::default()
        })
        .await?;

    let mut counts = EngineOperationCounts {
        pending: 0,
        accepted: 0,
        rejected: 0,
        conflict: 0,
        total: 0,
    };
    let mut collection_operation_counts: BTreeMap<String, usize> = BTreeMap::new();

    for stored in &operations {
        count_status(&mut counts, &stored.status);
        *collection_operation_counts
            .entry(stored.operation.key.collection.to_string())
            .or_default() += 1;
    }

    let mut collections = Vec::with_capacity(collection_operation_counts.len());
    for (collection, operations) in collection_operation_counts {
        let records = state
            .engine
            .storage()
            .list_records(&scope, &CollectionName::from(collection.clone()))
            .await?
            .into_iter()
            .filter(|record| !record.is_deleted())
            .count();
        collections.push(EngineCollectionDebugState {
            collection,
            records,
            operations,
        });
    }

    let mut recent_operations = operations;
    recent_operations.sort_by_key(|stored| std::cmp::Reverse(stored.local_sequence));
    let recent_operations = recent_operations
        .into_iter()
        .take(20)
        .map(|stored| EngineRecentOperation {
            operation_id: stored.operation.id.to_string(),
            collection: stored.operation.key.collection.to_string(),
            record_id: stored.operation.key.record_id.to_string(),
            actor_id: stored.operation.actor_id.to_string(),
            kind: operation_kind_label(&stored.operation.kind).to_owned(),
            status: stored.status.as_str().to_owned(),
            local_sequence: stored.local_sequence,
            remote_sequence: stored.remote_sequence,
            received_at_ms: stored.received_at_ms,
        })
        .collect();

    let remote = RemoteId::from(ENGINE_ACTOR_ID);
    let cursor = state.engine.storage().get_cursor(&scope, &remote).await?;

    Ok(Json(EngineDebugState {
        role: "photon-engine-authority".to_owned(),
        scope: scope.to_string(),
        remote: ENGINE_ACTOR_ID.to_owned(),
        next_remote_sequence: state.engine_next_seq.load(Ordering::SeqCst) + 1,
        cursor_position: cursor.map(|cursor| cursor.position),
        counts,
        collections,
        recent_operations,
    }))
}

// ---------------------------------------------------------------------------
// Photon Live — yrs CRDT realtime UX sync
//
// This WebSocket path owns collaborative feel: active room broadcast, presence,
// awareness-friendly Yjs updates, and reconnect behavior. Durable mutation
// truth remains in Photon Engine and the REST/RPC API write paths above.
// ---------------------------------------------------------------------------

async fn ws_handler(
    // `Option` so the authorization verdict comes first: an unauthenticated
    // caller learns 401/403, never details about the upgrade handshake.
    ws: Option<WebSocketUpgrade>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    // Browsers cannot set headers on a WebSocket handshake, so the token may
    // also arrive as a query parameter.
    let token = bearer_token(&headers)
        .map(str::to_owned)
        .or_else(|| params.get("token").cloned());
    let grant = match state.auth.authorize(token.as_deref()) {
        Ok(grant) => grant,
        Err(error) => return AppError::from(error).into_response(),
    };

    let room_id = params
        .get("room")
        .filter(|room| !room.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_ROOM_ID.to_string());
    let (tenant_id, _) = room_tenant_and_scope(&room_id);
    if !grant.allows_tenant(&tenant_id) {
        return AppError::Forbidden("token is not granted access to this room's tenant")
            .into_response();
    }

    let Some(ws) = ws else {
        return StatusCode::UPGRADE_REQUIRED.into_response();
    };

    ws.on_upgrade(move |socket| async move {
        match get_or_create_room(&state, &room_id).await {
            Ok(room) => handle_ws(socket, room).await,
            Err(err) => {
                tracing::error!(room = %room_id, error = %err, "Failed to initialize Yjs room");
            }
        }
    })
    .into_response()
}

async fn get_or_create_room(
    state: &Arc<AppState>,
    room_id: &str,
) -> Result<Arc<RoomState>, sqlx::Error> {
    if let Some(room) = state.rooms.read().await.get(room_id).cloned() {
        return Ok(room);
    }

    let mut rooms = state.rooms.write().await;
    if let Some(room) = rooms.get(room_id).cloned() {
        return Ok(room);
    }

    let (doc, max_seq) = hydrate_yjs_doc(&state.db, room_id).await?;
    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
    let (presence_tx, _) = broadcast::channel::<String>(256);
    let (tenant_id, engine_scope) = room_tenant_and_scope(room_id);
    let room = Arc::new(RoomState {
        db: state.db.clone(),
        engine: state.engine.clone(),
        doc: RwLock::new(doc),
        broadcast_tx,
        presence_tx,
        active_connections: AtomicUsize::new(0),
        room_id: room_id.to_string(),
        tenant_id,
        engine_scope,
        next_seq: AtomicI64::new(max_seq),
    });

    rooms.insert(room_id.to_string(), room.clone());
    Ok(room)
}

fn is_awareness_message(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|kind| kind.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some("awareness")
}

async fn handle_ws(socket: WebSocket, state: Arc<RoomState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let active_count = state.active_connections.fetch_add(1, Ordering::SeqCst) + 1;

    // Subscribe BEFORE encoding the initial snapshot. In the other order an
    // update that lands between the snapshot read and the subscription is in
    // neither — nothing ever retransmits it, so the late-joining client stays
    // behind until an unrelated update happens to arrive. Subscribing first
    // means the worst case is receiving an update the snapshot already
    // contains, and applying a Yjs update twice is a no-op.
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let mut presence_rx = state.presence_tx.subscribe();

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
                Message::Text(text) if is_awareness_message(&text) => {
                    let _ = recv_state.presence_tx.send(text);
                }
                Message::Text(_) => {}
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
    Sqlx(sqlx::Error),
    Engine(photon_engine::EngineError),
    Serde(serde_json::Error),
    Unauthorized(&'static str),
    Forbidden(&'static str),
    BadRequest(String),
}

impl From<AuthError> for AppError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::MissingToken => AppError::Unauthorized("missing bearer token"),
            AuthError::InvalidToken => AppError::Unauthorized("invalid bearer token"),
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Sqlx(e)
    }
}

impl From<photon_engine::EngineError> for AppError {
    fn from(e: photon_engine::EngineError) -> Self {
        AppError::Engine(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Serde(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::Sqlx(e) => {
                tracing::error!("Database error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_owned(),
                )
            }
            AppError::Engine(e) => {
                tracing::error!("Photon engine error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_owned(),
                )
            }
            AppError::Serde(e) => {
                tracing::error!("Serialization error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_owned(),
                )
            }
            AppError::Unauthorized(message) => (StatusCode::UNAUTHORIZED, message.to_owned()),
            AppError::Forbidden(message) => (StatusCode::FORBIDDEN, message.to_owned()),
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(include_str!("../migrations/002_create_yjs_state.sql"))
        .execute(pool)
        .await?;
    Ok(())
}

async fn init_engine(
    pool: &SqlitePool,
    engine_database_url: &str,
) -> Result<PhotonEngine<ServerEngineAdapter>, photon_engine::EngineError> {
    if engine_database_url.starts_with("mysql://") || engine_database_url.starts_with("tidb://") {
        let database_url = normalize_engine_database_url(engine_database_url);
        let adapter = MySqlAdapter::connect(&database_url).await?;
        return Ok(PhotonEngine::new(ServerEngineAdapter::MySql(adapter)));
    }

    let adapter = SqliteAdapter::from_pool(pool.clone());
    adapter.migrate().await?;
    Ok(PhotonEngine::new(ServerEngineAdapter::Sqlite(adapter)))
}

async fn verify_engine_startup(
    engine: &PhotonEngine<ServerEngineAdapter>,
    engine_database_url: &str,
) -> photon_engine::Result<()> {
    engine
        .storage()
        .list_operations(OperationFilter {
            limit: Some(1),
            ..OperationFilter::default()
        })
        .await?;
    info!(
        "Photon Engine storage ready: kind={}, schema=prepared",
        engine_database_kind(engine_database_url)
    );
    Ok(())
}

async fn init_engine_next_sequence(
    engine: &PhotonEngine<ServerEngineAdapter>,
) -> photon_engine::Result<i64> {
    let operations = engine
        .storage()
        .list_operations(OperationFilter {
            status: Some(OperationStatus::Accepted),
            ..OperationFilter::default()
        })
        .await?;
    Ok(operations
        .into_iter()
        .filter_map(|operation| operation.remote_sequence)
        .max()
        .unwrap_or_default())
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
    state: &Arc<RoomState>,
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

    state
        .engine
        .storage()
        .append_snapshot_update(
            SnapshotUpdate::new(
                engine_yjs_snapshot_key(&state.engine_scope, &state.room_id),
                seq,
                update_bytes.to_vec(),
                ENGINE_YJS_UPDATE_FORMAT,
            )
            .with_metadata(serde_json::json!({
                "room_id": state.room_id,
                "source": "photon-server-yjs"
            })),
        )
        .await
        .map_err(engine_error_to_sqlx)?;

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
async fn compact_yjs_log(state: &Arc<RoomState>) -> Result<(), sqlx::Error> {
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

    state
        .engine
        .storage()
        .save_snapshot(
            Snapshot::new(
                engine_yjs_snapshot_key(&state.engine_scope, &state.room_id),
                boundary_seq,
                snapshot_bytes,
                ENGINE_YJS_SNAPSHOT_FORMAT,
            )
            .with_metadata(serde_json::json!({
                "room_id": state.room_id,
                "source": "photon-server-yjs-compaction"
            })),
        )
        .await
        .map_err(engine_error_to_sqlx)?;
    state
        .engine
        .storage()
        .compact_snapshot_updates(
            &engine_yjs_snapshot_key(&state.engine_scope, &state.room_id),
            boundary_seq,
        )
        .await
        .map_err(engine_error_to_sqlx)?;

    info!(
        room = %state.room_id,
        boundary_seq,
        snapshot_bytes = snapshot_len,
        "Compacted yjs update log into snapshot"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use photon_engine::ActorId;
    use tower::ServiceExt;

    fn engine_record_key(collection: &str, record_id: &str) -> RecordKey {
        engine_record_key_for_scope(default_workspace_scope(), collection, record_id)
    }

    async fn test_state() -> Arc<AppState> {
        test_state_with_auth(AuthConfig::disabled()).await
    }

    async fn test_state_with_auth(auth: AuthConfig) -> Arc<AppState> {
        test_state_with(auth, Arc::new(AllowAllPolicy)).await
    }

    async fn test_state_with(auth: AuthConfig, policy: Arc<dyn EnginePolicy>) -> Arc<AppState> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        init_db(&pool).await.unwrap();
        let engine = init_engine(&pool, "sqlite::memory:").await.unwrap();
        let engine_next_seq = init_engine_next_sequence(&engine).await.unwrap();

        Arc::new(AppState {
            db: pool,
            engine,
            engine_next_seq: AtomicI64::new(engine_next_seq),
            engine_push_lock: tokio::sync::Mutex::new(()),
            rooms: RwLock::new(HashMap::new()),
            auth,
            policy,
        })
    }

    async fn engine_test_app() -> (Router, Arc<AppState>) {
        let state = test_state().await;
        (engine_routes().with_state(state.clone()), state)
    }

    /// Trusts `edge-token` for every tenant and `acme-token` for tenant
    /// `acme` only.
    async fn authed_test_state() -> Arc<AppState> {
        test_state_with_auth(AuthConfig::from_spec("edge-token,acme-token@acme").unwrap()).await
    }

    async fn live_test_app() -> (Router, Arc<AppState>) {
        let state = test_state().await;
        (live_routes().with_state(state.clone()), state)
    }

    async fn test_app() -> (Router, Arc<AppState>) {
        engine_test_app().await
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
    async fn test_engine_and_live_test_servers_are_separate() {
        let (engine_app, _) = engine_test_app().await;
        let engine_ws_resp = engine_app
            .oneshot(Request::builder().uri("/ws").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(engine_ws_resp.status(), StatusCode::NOT_FOUND);

        let (live_app, _) = live_test_app().await;
        let live_api_resp = live_app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(live_api_resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_engine_push_and_pull_sync_endpoint() {
        let (app, _) = engine_test_app().await;
        let operation = Operation::new(
            engine_record_key("issues", "issue-sync-1"),
            ActorId::from("client-a"),
            OperationKind::Upsert {
                value: serde_json::json!({
                    "id": "issue-sync-1",
                    "identifier": "PLT-901",
                    "title": "Sync me"
                }),
            },
        );

        let push_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/engine/push")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_string(&PushRequest {
                            scope: default_workspace_scope(),
                            operations: vec![operation.clone()],
                            cursor: None,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(push_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(push_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let pushed: PushResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(pushed.decisions.len(), 1);
        assert!(matches!(
            pushed.decisions[0],
            PushDecision::Accepted {
                remote_sequence: 1,
                ..
            }
        ));

        let pull_resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/engine/pull")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_string(&PullRequest {
                            scope: default_workspace_scope(),
                            cursor: None,
                            limit: None,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(pull_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(pull_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let pulled: PullResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(pulled.operations.len(), 1);
        assert_eq!(pulled.operations[0].operation.id, operation.id);
        assert_eq!(pulled.operations[0].remote_sequence, 1);
    }

    #[tokio::test]
    async fn test_engine_debug_endpoint_reports_recent_sync_state() {
        let (app, _) = engine_test_app().await;
        let operation = Operation::new(
            engine_record_key("issues", "issue-debug-1"),
            ActorId::from("client-debug"),
            OperationKind::Upsert {
                value: serde_json::json!({
                    "id": "issue-debug-1",
                    "identifier": "PLT-902",
                    "title": "Debug me"
                }),
            },
        );

        let push_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/engine/push")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_string(&PushRequest {
                            scope: default_workspace_scope(),
                            operations: vec![operation.clone()],
                            cursor: None,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(push_resp.status(), StatusCode::OK);

        let debug_resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/engine/debug")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(debug_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(debug_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let debug: EngineDebugState = serde_json::from_slice(&body).unwrap();
        assert_eq!(debug.counts.accepted, 1);
        assert_eq!(debug.collections[0].collection, "issues");
        assert_eq!(debug.collections[0].records, 1);
        assert_eq!(
            debug.recent_operations[0].operation_id,
            operation.id.to_string()
        );
        assert_eq!(debug.recent_operations[0].remote_sequence, Some(1));
    }

    #[tokio::test]
    async fn test_engine_debug_endpoint_is_tenant_workspace_scoped() {
        let (app, _) = engine_test_app().await;
        let acme_scope = workspace_scope("acme", "roadmap");
        let globex_scope = workspace_scope("globex", "roadmap");
        let acme_operation = Operation::new(
            engine_record_key_for_scope(acme_scope.clone(), "issues", "issue-acme-1"),
            ActorId::from("client-acme"),
            OperationKind::Upsert {
                value: serde_json::json!({ "id": "issue-acme-1", "title": "Acme roadmap" }),
            },
        );
        let globex_operation = Operation::new(
            engine_record_key_for_scope(globex_scope, "issues", "issue-globex-1"),
            ActorId::from("client-globex"),
            OperationKind::Upsert {
                value: serde_json::json!({ "id": "issue-globex-1", "title": "Globex roadmap" }),
            },
        );

        for (scope, operation) in [
            (acme_scope.clone(), acme_operation.clone()),
            (workspace_scope("globex", "roadmap"), globex_operation),
        ] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/engine/push")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_string(&PushRequest {
                                scope,
                                operations: vec![operation],
                                cursor: None,
                            })
                            .unwrap(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
        }

        let debug_resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/engine/debug?tenant_id=acme&workspace_id=roadmap")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(debug_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(debug_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let debug: EngineDebugState = serde_json::from_slice(&body).unwrap();
        assert_eq!(debug.scope, acme_scope.to_string());
        assert_eq!(debug.counts.accepted, 1);
        assert_eq!(
            debug.recent_operations[0].operation_id,
            acme_operation.id.to_string()
        );
    }

    // -----------------------------------------------------------------------
    // Auth boundary tests
    // -----------------------------------------------------------------------

    fn push_body(scope: ScopeId, operation: Operation) -> String {
        serde_json::to_string(&PushRequest {
            scope,
            operations: vec![operation],
            cursor: None,
        })
        .unwrap()
    }

    fn json_post(uri: &str, token: Option<&str>, body: String) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder.body(Body::from(body)).unwrap()
    }

    fn acme_push_body() -> String {
        let scope = workspace_scope("acme", "roadmap");
        push_body(
            scope.clone(),
            Operation::new(
                engine_record_key_for_scope(scope, "issues", "issue-auth-1"),
                ActorId::from("client-acme"),
                OperationKind::Upsert {
                    value: serde_json::json!({ "id": "issue-auth-1", "title": "Authorized" }),
                },
            ),
        )
    }

    #[tokio::test]
    async fn test_push_requires_a_trusted_bearer_token() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);

        let missing = app
            .clone()
            .oneshot(json_post("/api/engine/push", None, acme_push_body()))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let invalid = app
            .clone()
            .oneshot(json_post(
                "/api/engine/push",
                Some("wrong-token"),
                acme_push_body(),
            ))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED);

        let valid = app
            .oneshot(json_post(
                "/api/engine/push",
                Some("acme-token"),
                acme_push_body(),
            ))
            .await
            .unwrap();
        assert_eq!(valid.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_push_confines_a_tenant_token_to_its_tenant() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);

        let globex_scope = workspace_scope("globex", "roadmap");
        let globex_body = push_body(
            globex_scope.clone(),
            Operation::new(
                engine_record_key_for_scope(globex_scope, "issues", "issue-globex-1"),
                ActorId::from("client-globex"),
                OperationKind::Upsert {
                    value: serde_json::json!({ "id": "issue-globex-1" }),
                },
            ),
        );

        let cross_tenant = app
            .clone()
            .oneshot(json_post(
                "/api/engine/push",
                Some("acme-token"),
                globex_body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(cross_tenant.status(), StatusCode::FORBIDDEN);

        // The all-tenants service token may write anywhere.
        let service = app
            .oneshot(json_post(
                "/api/engine/push",
                Some("edge-token"),
                globex_body,
            ))
            .await
            .unwrap();
        assert_eq!(service.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_push_rejects_malformed_scopes() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);

        let malformed_scope = ScopeId::from("workspace:acme:roadmap");
        let body = push_body(
            malformed_scope.clone(),
            Operation::new(
                engine_record_key_for_scope(malformed_scope, "issues", "issue-1"),
                ActorId::from("client"),
                OperationKind::Upsert {
                    value: serde_json::json!({}),
                },
            ),
        );

        let resp = app
            .oneshot(json_post("/api/engine/push", Some("edge-token"), body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_push_rejects_an_operation_scoped_outside_the_request() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);

        // Request says acme, but the operation's own key targets globex. This
        // is the smuggling path the per-operation check exists to close.
        let body = push_body(
            workspace_scope("acme", "roadmap"),
            Operation::new(
                engine_record_key_for_scope(
                    workspace_scope("globex", "roadmap"),
                    "issues",
                    "issue-smuggled",
                ),
                ActorId::from("client-acme"),
                OperationKind::Upsert {
                    value: serde_json::json!({ "id": "issue-smuggled" }),
                },
            ),
        );

        let resp = app
            .oneshot(json_post("/api/engine/push", Some("acme-token"), body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_pull_enforces_the_same_boundary_as_push() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);

        let pull_body = |scope: ScopeId| {
            serde_json::to_string(&PullRequest {
                scope,
                cursor: None,
                limit: None,
            })
            .unwrap()
        };

        let missing = app
            .clone()
            .oneshot(json_post(
                "/api/engine/pull",
                None,
                pull_body(workspace_scope("acme", "roadmap")),
            ))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let cross_tenant = app
            .clone()
            .oneshot(json_post(
                "/api/engine/pull",
                Some("acme-token"),
                pull_body(workspace_scope("globex", "roadmap")),
            ))
            .await
            .unwrap();
        assert_eq!(cross_tenant.status(), StatusCode::FORBIDDEN);

        let allowed = app
            .oneshot(json_post(
                "/api/engine/pull",
                Some("acme-token"),
                pull_body(workspace_scope("acme", "roadmap")),
            ))
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_debug_endpoint_enforces_the_tenant_grant() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);

        let request = |token: Option<&str>, uri: &str| {
            let mut builder = Request::builder().uri(uri);
            if let Some(token) = token {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            builder.body(Body::empty()).unwrap()
        };

        let missing = app
            .clone()
            .oneshot(request(None, "/api/engine/debug?tenant_id=acme"))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let cross_tenant = app
            .clone()
            .oneshot(request(
                Some("acme-token"),
                "/api/engine/debug?tenant_id=globex",
            ))
            .await
            .unwrap();
        assert_eq!(cross_tenant.status(), StatusCode::FORBIDDEN);

        // Without an explicit tenant the endpoint reports the default tenant,
        // which a tenant-confined token is not granted either.
        let default_tenant = app
            .clone()
            .oneshot(request(Some("acme-token"), "/api/engine/debug"))
            .await
            .unwrap();
        assert_eq!(default_tenant.status(), StatusCode::FORBIDDEN);

        let allowed = app
            .oneshot(request(
                Some("acme-token"),
                "/api/engine/debug?tenant_id=acme",
            ))
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_ws_handshake_enforces_token_and_room_tenant() {
        let state = authed_test_state().await;
        let app = live_routes().with_state(state);

        let ws_request = |uri: &str| {
            Request::builder()
                .uri(uri)
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .unwrap()
        };

        let missing = app.clone().oneshot(ws_request("/ws")).await.unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        // A tenant-confined token may not join a room pinned to another
        // tenant, nor an unscoped room (which belongs to the default tenant).
        let cross_tenant = app
            .clone()
            .oneshot(ws_request(
                "/ws?token=acme-token&room=tenant:globex:workspace:roadmap:records",
            ))
            .await
            .unwrap();
        assert_eq!(cross_tenant.status(), StatusCode::FORBIDDEN);

        let unscoped_room = app
            .clone()
            .oneshot(ws_request("/ws?token=acme-token&room=records"))
            .await
            .unwrap();
        assert_eq!(unscoped_room.status(), StatusCode::FORBIDDEN);

        // A synthetic `oneshot` request carries no hyper upgrade extension, so
        // an *authorized* handshake ends at 426 here. The point of the
        // assertion is that authorization passed: anything but 401/403.
        let allowed = app
            .oneshot(ws_request(
                "/ws?token=acme-token&room=tenant:acme:workspace:roadmap:records",
            ))
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::UPGRADE_REQUIRED);
    }

    #[tokio::test]
    async fn test_broadcast_engine_changed_only_wakes_the_pushing_tenant() {
        let state = test_state().await;
        let acme_room = get_or_create_room(&state, "tenant:acme:workspace:roadmap:records")
            .await
            .unwrap();
        let default_room = get_or_create_room(&state, "records").await.unwrap();

        let mut acme_rx = acme_room.presence_tx.subscribe();
        let mut default_rx = default_room.presence_tx.subscribe();

        broadcast_engine_changed(&state, "acme", 42).await;

        // The frame is a pull hint: the cursor rides along, operations do not.
        let frame = acme_rx.try_recv().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(parsed["type"], "engine-changed");
        assert_eq!(parsed["cursor"], 42);
        assert!(
            default_rx.try_recv().is_err(),
            "a default-tenant room must not learn about another tenant's push"
        );
    }

    #[tokio::test]
    async fn test_pull_paging_survives_a_legacy_row_without_a_remote_sequence() {
        let (app, state) = engine_test_app().await;

        // A legacy row: accepted before the server started assigning remote
        // sequences. It sits first in local order, inside the first page.
        state
            .engine
            .storage()
            .append_operation(
                Operation::new(
                    engine_record_key("records", "legacy-1"),
                    ActorId::from("legacy-client"),
                    OperationKind::Upsert {
                        value: serde_json::json!({ "id": "legacy-1" }),
                    },
                ),
                OperationStatus::Accepted,
            )
            .await
            .unwrap();

        let operations: Vec<_> = (1..=3)
            .map(|i| {
                Operation::new(
                    engine_record_key("records", &format!("record-page-{i}")),
                    ActorId::from("client-a"),
                    OperationKind::Upsert {
                        value: serde_json::json!({ "id": format!("record-page-{i}") }),
                    },
                )
            })
            .collect();
        let push_resp = app
            .clone()
            .oneshot(json_post(
                "/api/engine/push",
                None,
                serde_json::to_string(&PushRequest {
                    scope: default_workspace_scope(),
                    operations,
                    cursor: None,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(push_resp.status(), StatusCode::OK);

        // First page, limit 3: the fetch is [legacy, seq 1, seq 2]. Only two
        // rows have a sequence, but the page was full — paging must continue,
        // or everything behind the legacy row becomes unreachable.
        let pull = |cursor: Option<SyncCursor>| {
            let app = app.clone();
            async move {
                let resp = app
                    .oneshot(json_post(
                        "/api/engine/pull",
                        None,
                        serde_json::to_string(&PullRequest {
                            scope: default_workspace_scope(),
                            cursor,
                            limit: Some(3),
                        })
                        .unwrap(),
                    ))
                    .await
                    .unwrap();
                assert_eq!(resp.status(), StatusCode::OK);
                let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                    .await
                    .unwrap();
                serde_json::from_slice::<PullResult>(&body).unwrap()
            }
        };

        let first = pull(None).await;
        assert_eq!(first.operations.len(), 2);
        assert!(first.has_more, "a full fetch page must keep paging");

        let second = pull(first.cursor.clone()).await;
        assert_eq!(second.operations.len(), 1);
        assert_eq!(second.operations[0].remote_sequence, 3);
    }

    #[tokio::test]
    async fn test_push_broadcasts_the_advanced_cursor_as_a_pull_hint() {
        let (app, state) = engine_test_app().await;
        let room = get_or_create_room(&state, "records").await.unwrap();
        let mut rx = room.presence_tx.subscribe();

        let operations: Vec<_> = (1..=2)
            .map(|i| {
                Operation::new(
                    engine_record_key("issues", &format!("issue-hint-{i}")),
                    ActorId::from("client-a"),
                    OperationKind::Upsert {
                        value: serde_json::json!({ "id": format!("issue-hint-{i}") }),
                    },
                )
            })
            .collect();

        let resp = app
            .oneshot(json_post(
                "/api/engine/push",
                None,
                serde_json::to_string(&PushRequest {
                    scope: default_workspace_scope(),
                    operations,
                    cursor: None,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // The hint carries the sequence the push advanced to — cursor only,
        // never the operations themselves.
        let frame = rx.try_recv().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(parsed["type"], "engine-changed");
        assert_eq!(parsed["cursor"], 2);
        assert!(parsed.get("operations").is_none());
    }

    #[test]
    fn test_room_tenant_and_scope_follows_the_room_convention() {
        let (tenant, scope) = room_tenant_and_scope("tenant:acme:workspace:roadmap:records");
        assert_eq!(tenant, "acme");
        assert_eq!(scope, workspace_scope("acme", "roadmap"));

        let (tenant, scope) = room_tenant_and_scope("tenant:acme:workspace:roadmap:doc:42");
        assert_eq!(tenant, "acme");
        assert_eq!(scope, workspace_scope("acme", "roadmap"));

        for unscoped in ["records", "default", "tenant:acme", "tenant::workspace:x"] {
            let (tenant, scope) = room_tenant_and_scope(unscoped);
            assert_eq!(tenant, DEFAULT_TENANT_ID, "room {unscoped:?}");
            assert_eq!(scope, default_workspace_scope());
        }
    }

    // -----------------------------------------------------------------------
    // Policy hook + audit metadata tests
    // -----------------------------------------------------------------------

    /// A host policy: `audit_events` is server-owned, nobody may write to it.
    struct LockedCollectionsPolicy;

    #[async_trait]
    impl EnginePolicy for LockedCollectionsPolicy {
        async fn authorize_operation(&self, ctx: OperationContext<'_>) -> PolicyVerdict {
            if ctx.operation.key.collection.to_string() == "audit_events" {
                PolicyVerdict::Reject {
                    reason: "audit_events is server-owned".into(),
                }
            } else {
                PolicyVerdict::Allow
            }
        }
    }

    #[tokio::test]
    async fn test_policy_rejects_per_operation_and_accepts_the_rest() {
        let state =
            test_state_with(AuthConfig::disabled(), Arc::new(LockedCollectionsPolicy)).await;
        let app = engine_routes().with_state(state);
        let scope = default_workspace_scope();

        let allowed = Operation::new(
            engine_record_key("issues", "issue-policy-1"),
            ActorId::from("client-a"),
            OperationKind::Upsert {
                value: serde_json::json!({ "id": "issue-policy-1" }),
            },
        );
        let locked = Operation::new(
            engine_record_key("audit_events", "event-1"),
            ActorId::from("client-a"),
            OperationKind::Upsert {
                value: serde_json::json!({ "id": "event-1" }),
            },
        );

        let resp = app
            .clone()
            .oneshot(json_post(
                "/api/engine/push",
                None,
                serde_json::to_string(&PushRequest {
                    scope: scope.clone(),
                    operations: vec![allowed.clone(), locked.clone()],
                    cursor: None,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let pushed: PushResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(pushed.decisions.len(), 2);
        assert!(matches!(
            &pushed.decisions[0],
            PushDecision::Accepted { operation_id, .. } if *operation_id == allowed.id
        ));
        match &pushed.decisions[1] {
            PushDecision::Rejected {
                operation_id,
                reason,
            } => {
                assert_eq!(*operation_id, locked.id);
                assert!(reason.contains("server-owned"));
            }
            other => panic!("expected a rejection, got {other:?}"),
        }

        // The rejected operation never reached the log.
        let pull_resp = app
            .oneshot(json_post(
                "/api/engine/pull",
                None,
                serde_json::to_string(&PullRequest {
                    scope,
                    cursor: None,
                    limit: None,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        let body = axum::body::to_bytes(pull_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let pulled: PullResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(pulled.operations.len(), 1);
        assert_eq!(pulled.operations[0].operation.id, allowed.id);
    }

    #[tokio::test]
    async fn test_accepted_operations_carry_audit_metadata() {
        let state = authed_test_state().await;
        let app = engine_routes().with_state(state);
        let scope = workspace_scope("acme", "roadmap");

        let operation = Operation::new(
            engine_record_key_for_scope(scope.clone(), "issues", "issue-audit-1"),
            ActorId::from("client-acme"),
            OperationKind::Upsert {
                value: serde_json::json!({ "id": "issue-audit-1" }),
            },
        );

        let push = Request::builder()
            .method("POST")
            .uri("/api/engine/push")
            .header("content-type", "application/json")
            .header("authorization", "Bearer acme-token")
            .header("x-photon-request-id", "req-audit-123")
            .body(Body::from(
                serde_json::to_string(&PushRequest {
                    scope: scope.clone(),
                    operations: vec![operation.clone()],
                    cursor: None,
                })
                .unwrap(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(push).await.unwrap().status(),
            StatusCode::OK
        );

        let pull_resp = app
            .oneshot(json_post(
                "/api/engine/pull",
                Some("acme-token"),
                serde_json::to_string(&PullRequest {
                    scope,
                    cursor: None,
                    limit: None,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        let body = axum::body::to_bytes(pull_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let pulled: PullResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(pulled.operations.len(), 1);

        let audit = &pulled.operations[0].operation.metadata[AUDIT_METADATA_KEY];
        assert_eq!(audit["authorized"], "tenant");
        assert_eq!(audit["tenant_id"], "acme");
        assert_eq!(audit["request_id"], "req-audit-123");
        assert!(audit["received_at_ms"].as_i64().unwrap() > 0);
    }

    #[test]
    fn test_audit_stamp_preserves_existing_metadata() {
        let mut operation = Operation::new(
            engine_record_key("issues", "issue-meta-1"),
            ActorId::from("client-a"),
            OperationKind::Upsert {
                value: serde_json::json!({}),
            },
        );
        operation.metadata = serde_json::json!({ "client_tag": "keep-me" });
        stamp_audit_metadata(&mut operation, &TokenGrant::AllTenants, "req-1", 42);
        assert_eq!(operation.metadata["client_tag"], "keep-me");
        assert_eq!(
            operation.metadata[AUDIT_METADATA_KEY]["authorized"],
            "service"
        );
        assert_eq!(operation.metadata[AUDIT_METADATA_KEY]["received_at_ms"], 42);

        // A non-object metadata value belongs to the client; never destroy it.
        let mut odd = operation.clone();
        odd.metadata = serde_json::json!("opaque-client-string");
        stamp_audit_metadata(&mut odd, &TokenGrant::AllTenants, "req-2", 43);
        assert_eq!(odd.metadata, serde_json::json!("opaque-client-string"));
    }

    #[test]
    fn test_engine_database_url_normalization_keeps_mysql_driver_compatible() {
        assert_eq!(
            normalize_engine_database_url("tidb://user:pass@tidb.example.com:4000/photon"),
            "mysql://user:pass@tidb.example.com:4000/photon"
        );
        assert_eq!(
            normalize_engine_database_url("mysql://user:pass@mysql.example.com:3306/photon"),
            "mysql://user:pass@mysql.example.com:3306/photon"
        );
    }

    #[test]
    fn test_engine_database_kind_labels_production_storage() {
        assert_eq!(
            engine_database_kind("tidb://user:pass@tidb.example.com:4000/photon"),
            "tidb"
        );
        assert_eq!(
            engine_database_kind("mysql://user:pass@mysql.example.com:3306/photon"),
            "mysql"
        );
        assert_eq!(engine_database_kind("sqlite:photon.db?mode=rwc"), "sqlite");
    }

    // -----------------------------------------------------------------------
    // Yjs persistence + replay tests
    // -----------------------------------------------------------------------

    use yrs::Map;

    fn make_test_state(pool: SqlitePool) -> Arc<RoomState> {
        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let (presence_tx, _) = broadcast::channel::<String>(256);
        let (tenant_id, engine_scope) = room_tenant_and_scope(DEFAULT_ROOM_ID);
        Arc::new(RoomState {
            db: pool.clone(),
            engine: PhotonEngine::new(ServerEngineAdapter::Sqlite(SqliteAdapter::from_pool(pool))),
            doc: RwLock::new(Doc::new()),
            broadcast_tx,
            presence_tx,
            active_connections: AtomicUsize::new(0),
            room_id: DEFAULT_ROOM_ID.to_string(),
            tenant_id,
            engine_scope,
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
        init_engine(&pool, "sqlite::memory:").await.unwrap();
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
        let engine_updates = state
            .engine
            .storage()
            .list_snapshot_updates(
                &engine_yjs_snapshot_key(&default_workspace_scope(), DEFAULT_ROOM_ID),
                0,
            )
            .await
            .unwrap();
        assert_eq!(engine_updates.len(), 1);
        assert_eq!(engine_updates[0].sequence, 1);
        assert_eq!(engine_updates[0].format.as_str(), ENGINE_YJS_UPDATE_FORMAT);
        assert_eq!(engine_updates[0].payload, update);

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
        let engine_updates = state
            .engine
            .storage()
            .list_snapshot_updates(
                &engine_yjs_snapshot_key(&default_workspace_scope(), DEFAULT_ROOM_ID),
                0,
            )
            .await
            .unwrap();
        assert!(engine_updates.is_empty());
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
        let engine_snapshot = state
            .engine
            .storage()
            .get_snapshot(&engine_yjs_snapshot_key(
                &default_workspace_scope(),
                DEFAULT_ROOM_ID,
            ))
            .await
            .unwrap()
            .unwrap();
        assert!(engine_snapshot.sequence <= state.next_seq.load(Ordering::SeqCst));
        assert_eq!(engine_snapshot.format.as_str(), ENGINE_YJS_SNAPSHOT_FORMAT);
        assert!(!engine_snapshot.payload.is_empty());
        let engine_updates = state
            .engine
            .storage()
            .list_snapshot_updates(
                &engine_yjs_snapshot_key(&default_workspace_scope(), DEFAULT_ROOM_ID),
                0,
            )
            .await
            .unwrap();
        assert!(engine_updates
            .iter()
            .all(|update| update.sequence > engine_snapshot.sequence));

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
        init_engine(&pool, "sqlite::memory:").await.unwrap();
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
