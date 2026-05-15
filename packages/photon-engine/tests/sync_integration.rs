use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use photon_engine::{
    ActorId, CollectionName, Conflict, HybridTimestamp, MemoryAdapter, Operation, OperationFilter,
    OperationKind, OperationStatus, PhotonEngine, PullRequest, PullResult, PulledOperation,
    PushDecision, PushRequest, PushResult, RecordKey, ScopeId, StorageAdapter, SyncCursor,
    SyncEndpoint,
};
use serde_json::{json, Value};

fn key(record_id: &str) -> RecordKey {
    RecordKey::new("workspace:test", "issues", record_id)
}

fn patch(record_id: &str, actor: &str, wall_time_ms: i64, fields: Value) -> Operation {
    let fields = fields
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();

    Operation::new(
        key(record_id),
        ActorId::from(actor),
        OperationKind::Patch { fields },
    )
    .with_timestamp(HybridTimestamp::new(wall_time_ms, 0, actor))
}

#[derive(Clone, Debug, Default)]
struct RemoteHub {
    inner: Arc<Mutex<RemoteHubState>>,
}

#[derive(Debug, Default)]
struct RemoteHubState {
    next_sequence: i64,
    operations: Vec<(i64, Operation)>,
    seen_operations: HashSet<String>,
    reject_operation_ids: HashSet<String>,
    conflict_operation_ids: HashSet<String>,
}

impl RemoteHub {
    fn reject_operation(self, operation_id: &str) -> Self {
        self.inner
            .lock()
            .unwrap()
            .reject_operation_ids
            .insert(operation_id.to_owned());
        self
    }

    fn conflict_operation(self, operation_id: &str) -> Self {
        self.inner
            .lock()
            .unwrap()
            .conflict_operation_ids
            .insert(operation_id.to_owned());
        self
    }
}

#[async_trait]
impl SyncEndpoint for RemoteHub {
    async fn push(&self, request: PushRequest) -> photon_engine::Result<PushResult> {
        let mut state = self.inner.lock().unwrap();
        let mut decisions = Vec::new();

        for operation in request.operations {
            let operation_id = operation.id.as_str().to_owned();

            if state.reject_operation_ids.contains(&operation_id) {
                decisions.push(PushDecision::Rejected {
                    operation_id: operation.id.clone(),
                    reason: "server validation rejected operation".to_owned(),
                });
                continue;
            }

            if state.conflict_operation_ids.contains(&operation_id) {
                decisions.push(PushDecision::Conflict {
                    operation_id: operation.id.clone(),
                    conflict: Conflict::new(
                        operation.key.clone(),
                        operation.id.clone(),
                        "status transition rejected",
                        Some(json!({ "status": "done" })),
                        Some(json!({ "status": "todo" })),
                    ),
                });
                continue;
            }

            if !state.seen_operations.insert(operation_id) {
                let remote_sequence = state
                    .operations
                    .iter()
                    .find(|(_, stored)| stored.id == operation.id)
                    .map(|(sequence, _)| *sequence)
                    .unwrap_or_default();
                decisions.push(PushDecision::Accepted {
                    operation_id: operation.id,
                    remote_sequence,
                });
                continue;
            }

            state.next_sequence += 1;
            let remote_sequence = state.next_sequence;
            decisions.push(PushDecision::Accepted {
                operation_id: operation.id.clone(),
                remote_sequence,
            });
            state.operations.push((remote_sequence, operation));
        }

        Ok(PushResult {
            decisions,
            server_operations: Vec::new(),
            cursor: None,
        })
    }

    async fn pull(&self, request: PullRequest) -> photon_engine::Result<PullResult> {
        let state = self.inner.lock().unwrap();
        let since = request
            .cursor
            .map(|cursor| cursor.position)
            .unwrap_or_default();
        let operations = state
            .operations
            .iter()
            .filter(|(sequence, _)| *sequence > since)
            .map(|(remote_sequence, operation)| PulledOperation {
                operation: operation.clone(),
                remote_sequence: *remote_sequence,
            })
            .collect::<Vec<_>>();
        let cursor = SyncCursor::new(request.scope, "origin", state.next_sequence);

        Ok(PullResult {
            operations,
            cursor: Some(cursor),
        })
    }
}

#[tokio::test]
async fn sync_once_converges_two_offline_clients_after_out_of_order_pushes() {
    let remote = RemoteHub::default();
    let client_a = PhotonEngine::new(MemoryAdapter::new());
    let client_b = PhotonEngine::new(MemoryAdapter::new());

    let create_from_a = patch(
        "issue-1",
        "actor-a",
        10,
        json!({ "title": "from client A" }),
    )
    .with_id("op-client-a-create");
    let update_from_b = patch(
        "issue-1",
        "actor-b",
        11,
        json!({ "title": "from client B", "status": "in_progress" }),
    )
    .with_id("op-client-b-update");

    client_a
        .apply_local_operation(create_from_a.clone())
        .await
        .unwrap();
    client_b
        .apply_local_operation(update_from_b.clone())
        .await
        .unwrap();

    let summary_a = client_a
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();
    let summary_b = client_b
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();
    let summary_a_second = client_a
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();

    assert_eq!(summary_a.pushed, 1);
    assert_eq!(summary_b.pushed, 1);
    assert_eq!(summary_b.pulled, 2);
    assert_eq!(summary_a_second.pulled, 1);

    let record_a = client_a.record(&key("issue-1")).await.unwrap().unwrap();
    let record_b = client_b.record(&key("issue-1")).await.unwrap().unwrap();

    assert_eq!(record_a.value, record_b.value);
    assert_eq!(record_a.value["title"], json!("from client B"));
    assert_eq!(record_a.value["status"], json!("in_progress"));

    let accepted_a = client_a
        .storage()
        .get_operation(&create_from_a.id)
        .await
        .unwrap()
        .unwrap();
    let accepted_b = client_b
        .storage()
        .get_operation(&update_from_b.id)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(accepted_a.status, OperationStatus::Accepted);
    assert_eq!(accepted_b.status, OperationStatus::Accepted);
    assert_eq!(accepted_a.remote_sequence, Some(1));
    assert_eq!(accepted_b.remote_sequence, Some(2));
}

#[tokio::test]
async fn duplicate_push_is_deduped_and_does_not_create_extra_pending_work() {
    let remote = RemoteHub::default();
    let storage = MemoryAdapter::new();
    let engine = PhotonEngine::new(storage.clone());
    let operation =
        patch("issue-1", "actor-a", 10, json!({ "title": "dedupe me" })).with_id("op-dedupe");

    storage
        .append_operation(operation.clone(), OperationStatus::Pending)
        .await
        .unwrap();
    storage
        .append_operation(operation.clone(), OperationStatus::Pending)
        .await
        .unwrap();

    let summary = engine
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();
    let pending = engine.pending_operations("workspace:test").await.unwrap();
    let accepted = storage
        .list_operations(OperationFilter {
            scope: Some(ScopeId::from("workspace:test")),
            collection: Some(CollectionName::from("issues")),
            status: Some(OperationStatus::Accepted),
            ..OperationFilter::default()
        })
        .await
        .unwrap();

    assert_eq!(summary.pushed, 1);
    assert!(pending.is_empty());
    assert_eq!(accepted.len(), 1);
}

#[tokio::test]
async fn sync_once_records_conflicts_as_first_class_state() {
    let operation =
        patch("issue-1", "actor-a", 10, json!({ "status": "done" })).with_id("op-conflict");
    let remote = RemoteHub::default().conflict_operation(operation.id.as_str());
    let storage = MemoryAdapter::new();
    let engine = PhotonEngine::new(storage.clone());

    engine
        .apply_local_operation(operation.clone())
        .await
        .unwrap();

    let summary = engine
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();
    let stored = storage.get_operation(&operation.id).await.unwrap().unwrap();
    let conflicts = storage
        .list_conflicts(
            &ScopeId::from("workspace:test"),
            Some(&CollectionName::from("issues")),
            None,
        )
        .await
        .unwrap();

    assert_eq!(summary.conflicts, 1);
    assert_eq!(stored.status, OperationStatus::Conflict);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].operation_id, operation.id);
}

#[tokio::test]
async fn sync_once_marks_server_rejections_without_retrying_them() {
    let operation =
        patch("issue-1", "actor-a", 10, json!({ "status": "blocked" })).with_id("op-rejected");
    let remote = RemoteHub::default().reject_operation(operation.id.as_str());
    let storage = MemoryAdapter::new();
    let engine = PhotonEngine::new(storage.clone());

    engine
        .apply_local_operation(operation.clone())
        .await
        .unwrap();

    let first_summary = engine
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();
    let second_summary = engine
        .sync_once("workspace:test", "origin", &remote)
        .await
        .unwrap();
    let stored = storage.get_operation(&operation.id).await.unwrap().unwrap();

    assert_eq!(first_summary.pushed, 1);
    assert_eq!(second_summary.pushed, 0);
    assert_eq!(stored.status, OperationStatus::Rejected);
}

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_adapter_persists_projection_cursor_and_operation_after_reopen() {
    let path = std::env::temp_dir().join(format!(
        "photon-engine-{}.db",
        photon_engine::OperationId::random().as_str()
    ));
    let database_url = format!("sqlite:{}?mode=rwc", path.display());
    let record_key = key("issue-persisted");
    let operation = patch(
        record_key.record_id.as_str(),
        "actor-a",
        10,
        json!({ "title": "survives reopen" }),
    )
    .with_id("op-sqlite-persisted");

    {
        let adapter = photon_engine::SqliteAdapter::connect(&database_url)
            .await
            .unwrap();
        let engine = PhotonEngine::new(adapter.clone());

        engine
            .apply_local_operation(operation.clone())
            .await
            .unwrap();
        adapter
            .save_cursor(SyncCursor::new("workspace:test", "origin", 7))
            .await
            .unwrap();
    }

    let adapter = photon_engine::SqliteAdapter::connect(&database_url)
        .await
        .unwrap();
    let record = adapter.get_record(&record_key).await.unwrap().unwrap();
    let stored = adapter.get_operation(&operation.id).await.unwrap().unwrap();
    let cursor = adapter
        .get_cursor(
            &ScopeId::from("workspace:test"),
            &photon_engine::RemoteId::from("origin"),
        )
        .await
        .unwrap()
        .unwrap();

    assert_eq!(record.value["title"], json!("survives reopen"));
    assert_eq!(stored.status, OperationStatus::Pending);
    assert_eq!(cursor.position, 7);

    let _ = std::fs::remove_file(path);
}
