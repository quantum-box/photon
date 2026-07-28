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
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use yrs::{updates::decoder::Decode, Doc, ReadTxn, StateVector, Transact, Update};

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

fn engine_yjs_snapshot_key(room_id: &str) -> RecordKey {
    engine_record_key_for_scope(default_workspace_scope(), ENGINE_YJS_COLLECTION, room_id)
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
    pub rooms: RwLock<HashMap<String, Arc<RoomState>>>,
}

pub struct RoomState {
    pub db: SqlitePool,
    pub engine: PhotonEngine<ServerEngineAdapter>,
    pub doc: RwLock<Doc>,
    pub broadcast_tx: broadcast::Sender<Vec<u8>>,
    pub presence_tx: broadcast::Sender<String>,
    pub active_connections: AtomicUsize,
    pub room_id: String,
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
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;

    init_db(&pool).await?;
    let engine = init_engine(&pool, engine_database_url).await?;
    verify_engine_startup(&engine, engine_database_url).await?;
    let engine_next_seq = init_engine_next_sequence(&engine).await?;

    Ok(Arc::new(AppState {
        db: pool,
        engine,
        engine_next_seq: AtomicI64::new(engine_next_seq),
        rooms: RwLock::new(HashMap::new()),
    }))
}

fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
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

async fn push_engine_operations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<PushRequest>,
) -> Result<Json<PushResult>, AppError> {
    let request_id = headers
        .get("x-photon-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none");
    let scope = payload.scope.clone();
    let operation_count = payload.operations.len();
    let mut decisions = Vec::with_capacity(payload.operations.len());
    let mut max_remote_sequence = 0;

    for operation in payload.operations {
        let remote_sequence = state.engine_next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        state
            .engine
            .apply_remote_operation(operation.clone(), remote_sequence)
            .await?;
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
        accepted = decisions.len(),
        max_remote_sequence,
        "Photon Engine push accepted operations",
    );

    // Wake up other clients' Engine sync loops right away instead of leaving
    // them to their poll interval. Rooms are keyed by Live room id, not Engine
    // scope, so every room is told; a pull that finds nothing new is cheap.
    if !decisions.is_empty() {
        broadcast_engine_changed(&state).await;
    }

    Ok(Json(PushResult {
        decisions,
        server_operations: Vec::new(),
        cursor,
    }))
}

/// Text frame sent over Photon Live sockets when the Engine op-log advanced.
const ENGINE_CHANGED_FRAME: &str = r#"{"type":"engine-changed"}"#;

async fn broadcast_engine_changed(state: &AppState) {
    for room in state.rooms.read().await.values() {
        // Send fails only when a room has no subscribers, which is fine.
        let _ = room.presence_tx.send(ENGINE_CHANGED_FRAME.to_string());
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
        has_more: pulled_count >= limit,
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
    Query(params): Query<ListParams>,
) -> Result<Json<EngineDebugState>, AppError> {
    let tenant_id = normalized_tenant_id(params.tenant_id);
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
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let room_id = params
        .get("room")
        .filter(|room| !room.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_ROOM_ID.to_string());

    ws.on_upgrade(move |socket| async move {
        match get_or_create_room(&state, &room_id).await {
            Ok(room) => handle_ws(socket, room).await,
            Err(err) => {
                tracing::error!(room = %room_id, error = %err, "Failed to initialize Yjs room");
            }
        }
    })
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
    let room = Arc::new(RoomState {
        db: state.db.clone(),
        engine: state.engine.clone(),
        doc: RwLock::new(doc),
        broadcast_tx,
        presence_tx,
        active_connections: AtomicUsize::new(0),
        room_id: room_id.to_string(),
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
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
            AppError::Engine(e) => {
                tracing::error!("Photon engine error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
            AppError::Serde(e) => {
                tracing::error!("Serialization error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
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
                engine_yjs_snapshot_key(&state.room_id),
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
                engine_yjs_snapshot_key(&state.room_id),
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
        .compact_snapshot_updates(&engine_yjs_snapshot_key(&state.room_id), boundary_seq)
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
            rooms: RwLock::new(HashMap::new()),
        })
    }

    async fn engine_test_app() -> (Router, Arc<AppState>) {
        let state = test_state().await;
        (engine_routes().with_state(state.clone()), state)
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
        Arc::new(RoomState {
            db: pool.clone(),
            engine: PhotonEngine::new(ServerEngineAdapter::Sqlite(SqliteAdapter::from_pool(pool))),
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
            .list_snapshot_updates(&engine_yjs_snapshot_key(DEFAULT_ROOM_ID), 0)
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
            .list_snapshot_updates(&engine_yjs_snapshot_key(DEFAULT_ROOM_ID), 0)
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
            .get_snapshot(&engine_yjs_snapshot_key(DEFAULT_ROOM_ID))
            .await
            .unwrap()
            .unwrap();
        assert!(engine_snapshot.sequence <= state.next_seq.load(Ordering::SeqCst));
        assert_eq!(engine_snapshot.format.as_str(), ENGINE_YJS_SNAPSHOT_FORMAT);
        assert!(!engine_snapshot.payload.is_empty());
        let engine_updates = state
            .engine
            .storage()
            .list_snapshot_updates(&engine_yjs_snapshot_key(DEFAULT_ROOM_ID), 0)
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
