use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use photon_engine::{
    CollectionName, Conflict, OperationFilter, OperationStatus, PhotonEngine, PullRequest,
    PullResult, PulledOperation, PushDecision, PushRequest, PushResult, Record, RecordKey, ScopeId,
    SqliteAdapter, StorageAdapter, SyncCursor,
};
use serde::Serialize;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

const DEFAULT_DATABASE_URL: &str = "sqlite:mock-tachyon-api.db?mode=rwc";
const DEFAULT_REMOTE_ID: &str = "mock-tachyon-api";

#[derive(Clone)]
struct MockTachyonState {
    engine: PhotonEngine<SqliteAdapter>,
    next_sequence: Arc<AtomicI64>,
}

#[derive(Debug)]
enum MockApiError {
    Engine(photon_engine::EngineError),
}

impl From<photon_engine::EngineError> for MockApiError {
    fn from(error: photon_engine::EngineError) -> Self {
        Self::Engine(error)
    }
}

impl From<serde_json::Error> for MockApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::Engine(photon_engine::EngineError::from(error))
    }
}

impl From<sqlx::Error> for MockApiError {
    fn from(error: sqlx::Error) -> Self {
        Self::Engine(photon_engine::EngineError::from(error))
    }
}

impl IntoResponse for MockApiError {
    fn into_response(self) -> axum::response::Response {
        match self {
            Self::Engine(error) => {
                tracing::error!(%error, "mock Tachyon API engine error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "engine error" })),
                )
                    .into_response()
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    remote: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mock_tachyon_api=debug,tower_http=debug".into()),
        )
        .init();

    let database_url =
        std::env::var("MOCK_TACHYON_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.into());
    let port = std::env::var("MOCK_TACHYON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3101);
    let state = init_state(&database_url).await?;
    let app = build_app(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    info!(%addr, %database_url, "Mock Tachyon API listening");
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn init_state(database_url: &str) -> photon_engine::Result<MockTachyonState> {
    let adapter = SqliteAdapter::connect(database_url).await?;
    let next_sequence = init_next_sequence(&adapter).await?;
    Ok(MockTachyonState {
        engine: PhotonEngine::new(adapter),
        next_sequence: Arc::new(AtomicI64::new(next_sequence)),
    })
}

async fn init_next_sequence(adapter: &SqliteAdapter) -> photon_engine::Result<i64> {
    let operations = adapter
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

fn build_app(state: MockTachyonState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/health", get(health))
        .route("/v1/sync/push", post(push_sync))
        .route("/v1/sync/pull", post(pull_sync))
        .route("/v1/records/:scope/:collection/:record_id", get(get_record))
        .route("/__admin/reset", post(reset_state))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        remote: DEFAULT_REMOTE_ID,
    })
}

async fn push_sync(
    State(state): State<MockTachyonState>,
    Json(request): Json<PushRequest>,
) -> Result<Json<PushResult>, MockApiError> {
    let mut decisions = Vec::with_capacity(request.operations.len());

    for operation in request.operations {
        if let Some(existing) = state.engine.storage().get_operation(&operation.id).await? {
            let decision = match existing.status {
                OperationStatus::Accepted => PushDecision::Accepted {
                    operation_id: existing.operation.id,
                    remote_sequence: existing.remote_sequence.unwrap_or_default(),
                },
                OperationStatus::Rejected => PushDecision::Rejected {
                    operation_id: existing.operation.id,
                    reason: "operation was previously rejected".into(),
                },
                OperationStatus::Conflict => PushDecision::Conflict {
                    operation_id: existing.operation.id.clone(),
                    conflict: Conflict::new(
                        existing.operation.key,
                        existing.operation.id,
                        "operation was previously marked as conflict",
                        None,
                        None,
                    ),
                },
                OperationStatus::Pending => PushDecision::Rejected {
                    operation_id: existing.operation.id,
                    reason: "remote operation is unexpectedly pending".into(),
                },
            };
            decisions.push(decision);
            continue;
        }

        if operation
            .metadata
            .get("mock_reject")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            decisions.push(PushDecision::Rejected {
                operation_id: operation.id,
                reason: "mock Tachyon validation rejected operation".into(),
            });
            continue;
        }

        if let Some(reason) = operation
            .metadata
            .get("mock_conflict_reason")
            .and_then(serde_json::Value::as_str)
        {
            decisions.push(PushDecision::Conflict {
                operation_id: operation.id.clone(),
                conflict: Conflict::new(
                    operation.key.clone(),
                    operation.id,
                    reason,
                    Some(serde_json::to_value(&operation.kind)?),
                    None,
                ),
            });
            continue;
        }

        let remote_sequence = state.next_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        state
            .engine
            .apply_remote_operation(operation.clone(), remote_sequence)
            .await?;
        decisions.push(PushDecision::Accepted {
            operation_id: operation.id,
            remote_sequence,
        });
    }

    let cursor = SyncCursor::new(request.scope, DEFAULT_REMOTE_ID, current_position(&state));
    Ok(Json(PushResult {
        decisions,
        server_operations: Vec::new(),
        cursor: Some(cursor),
    }))
}

async fn pull_sync(
    State(state): State<MockTachyonState>,
    Json(request): Json<PullRequest>,
) -> Result<Json<PullResult>, MockApiError> {
    let since = request
        .cursor
        .as_ref()
        .map(|cursor| cursor.position)
        .unwrap_or_default();
    let stored_operations = state
        .engine
        .storage()
        .list_operations(OperationFilter {
            scope: Some(request.scope.clone()),
            status: Some(OperationStatus::Accepted),
            after_remote_sequence: Some(since),
            ..OperationFilter::default()
        })
        .await?;
    let operations = stored_operations
        .into_iter()
        .filter_map(|stored| {
            stored
                .remote_sequence
                .map(|remote_sequence| PulledOperation {
                    operation: stored.operation,
                    remote_sequence,
                })
        })
        .collect::<Vec<_>>();
    let cursor = SyncCursor::new(request.scope, DEFAULT_REMOTE_ID, current_position(&state));

    Ok(Json(PullResult {
        operations,
        cursor: Some(cursor),
    }))
}

async fn get_record(
    State(state): State<MockTachyonState>,
    Path((scope, collection, record_id)): Path<(String, String, String)>,
) -> Result<(StatusCode, Json<Option<Record>>), MockApiError> {
    let key = RecordKey::new(
        ScopeId::from(scope),
        CollectionName::from(collection),
        record_id,
    );
    let record = state.engine.record(&key).await?;
    let status = if record.is_some() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    Ok((status, Json(record)))
}

async fn reset_state(State(state): State<MockTachyonState>) -> Result<StatusCode, MockApiError> {
    let pool = state.engine.storage().pool();
    for table in [
        "photon_engine_operations",
        "photon_engine_records",
        "photon_engine_cursors",
        "photon_engine_conflicts",
        "photon_engine_snapshots",
        "photon_engine_snapshot_updates",
    ] {
        let query = format!("DELETE FROM {table}");
        sqlx::query(&query).execute(pool).await?;
    }
    state.next_sequence.store(0, Ordering::SeqCst);
    Ok(StatusCode::NO_CONTENT)
}

fn current_position(state: &MockTachyonState) -> i64 {
    state.next_sequence.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use photon_engine::{ActorId, HybridTimestamp, Operation, OperationKind, SyncEndpoint};
    use serde::de::DeserializeOwned;
    use std::collections::BTreeMap;
    use tower::ServiceExt;

    #[derive(Clone)]
    struct RouterSyncEndpoint {
        app: Router,
    }

    #[async_trait]
    impl SyncEndpoint for RouterSyncEndpoint {
        async fn push(&self, request: PushRequest) -> photon_engine::Result<PushResult> {
            self.post_json("/v1/sync/push", &request).await
        }

        async fn pull(&self, request: PullRequest) -> photon_engine::Result<PullResult> {
            self.post_json("/v1/sync/pull", &request).await
        }
    }

    impl RouterSyncEndpoint {
        async fn post_json<T, B>(&self, path: &str, body: &B) -> photon_engine::Result<T>
        where
            T: DeserializeOwned,
            B: Serialize,
        {
            let response = self
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(body)?))
                        .unwrap(),
                )
                .await
                .map_err(|error| photon_engine::EngineError::Storage(error.to_string()))?;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .map_err(|error| photon_engine::EngineError::Storage(error.to_string()))?;
            Ok(serde_json::from_slice(&bytes)?)
        }
    }

    async fn test_state() -> MockTachyonState {
        init_state("sqlite::memory:").await.unwrap()
    }

    fn test_operation(record_id: &str, title: &str, wall_time_ms: i64) -> Operation {
        let mut fields = BTreeMap::new();
        fields.insert("title".into(), serde_json::json!(title));
        Operation::new(
            RecordKey::new("workspace:test", "issues", record_id),
            ActorId::from("client-a"),
            OperationKind::Patch { fields },
        )
        .with_timestamp(HybridTimestamp::new(wall_time_ms, 0, "client-a"))
    }

    #[tokio::test]
    async fn sync_once_round_trips_over_mock_tachyon_http_routes() {
        let state = test_state().await;
        let app = build_app(state);
        let endpoint = RouterSyncEndpoint { app: app.clone() };
        let client_a = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        let client_b = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        let operation = test_operation("issue-1", "from client A", 10);

        client_a.apply_local_operation(operation).await.unwrap();
        let summary_a = client_a
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();
        let summary_b = client_b
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();

        assert_eq!(summary_a.pushed, 1);
        assert_eq!(summary_b.pulled, 1);

        let record_a = client_a
            .record(&RecordKey::new("workspace:test", "issues", "issue-1"))
            .await
            .unwrap()
            .unwrap();
        let record_b = client_b
            .record(&RecordKey::new("workspace:test", "issues", "issue-1"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record_a.value, record_b.value);
        assert_eq!(record_b.value["title"], "from client A");

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/records/workspace:test/issues/issue-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn reset_clears_mock_tachyon_remote_state() {
        let state = test_state().await;
        let app = build_app(state);
        let endpoint = RouterSyncEndpoint { app: app.clone() };
        let client = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        client
            .apply_local_operation(test_operation("issue-1", "temporary", 10))
            .await
            .unwrap();
        client
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/__admin/reset")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/records/workspace:test/issues/issue-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
