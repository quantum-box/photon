use std::collections::BTreeMap;

use photon_engine::{
    ActorId, CollectionName, Conflict, HybridTimestamp, MemoryAdapter, Operation, OperationFilter,
    OperationKind, OperationStatus, PhotonEngine, RecordKey, RemoteId, ScopeId, StorageAdapter,
    SyncCursor,
};
use serde_json::json;

fn key(record_id: &str) -> RecordKey {
    RecordKey::new("workspace:test", "issues", record_id)
}

fn patch(record_id: &str, actor: &str, wall_time_ms: i64, fields: serde_json::Value) -> Operation {
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

async fn run_storage_contract<A>(adapter: A)
where
    A: StorageAdapter + Clone,
{
    let engine = PhotonEngine::new(adapter.clone());
    let op = patch(
        "issue-1",
        "actor-a",
        10,
        json!({ "title": "offline issue" }),
    )
    .with_id("op-create-issue-1");

    adapter
        .append_operation(op.clone(), OperationStatus::Pending)
        .await
        .unwrap();
    adapter
        .append_operation(op.clone(), OperationStatus::Pending)
        .await
        .unwrap();

    let pending = adapter
        .list_operations(OperationFilter::pending_for_scope("workspace:test"))
        .await
        .unwrap();
    assert_eq!(pending.len(), 1, "operation append must be idempotent");

    let record = engine.apply_local_operation(op.clone()).await.unwrap();
    assert_eq!(record.value["title"], json!("offline issue"));

    let stored = adapter.get_operation(&op.id).await.unwrap().unwrap();
    assert_eq!(stored.status, OperationStatus::Pending);

    adapter
        .mark_operation_status(&op.id, OperationStatus::Accepted, Some(42))
        .await
        .unwrap();
    let accepted = adapter.get_operation(&op.id).await.unwrap().unwrap();
    assert_eq!(accepted.status, OperationStatus::Accepted);
    assert_eq!(accepted.remote_sequence, Some(42));

    let cursor = SyncCursor::new("workspace:test", "origin", 42);
    adapter.save_cursor(cursor.clone()).await.unwrap();
    let loaded_cursor = adapter
        .get_cursor(&ScopeId::from("workspace:test"), &RemoteId::from("origin"))
        .await
        .unwrap();
    assert_eq!(loaded_cursor, Some(cursor));

    let conflict = Conflict::new(
        key("issue-1"),
        op.id.clone(),
        "status transition rejected",
        Some(json!({ "status": "done" })),
        Some(json!({ "status": "todo" })),
    );
    adapter.save_conflict(conflict.clone()).await.unwrap();
    let conflicts = adapter
        .list_conflicts(
            &ScopeId::from("workspace:test"),
            Some(&CollectionName::from("issues")),
            None,
        )
        .await
        .unwrap();
    assert_eq!(conflicts, vec![conflict]);

    let records = adapter
        .list_records(
            &ScopeId::from("workspace:test"),
            &CollectionName::from("issues"),
        )
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
}

#[tokio::test]
async fn memory_adapter_satisfies_storage_contract() {
    run_storage_contract(MemoryAdapter::new()).await;
}

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_adapter_satisfies_storage_contract() {
    let adapter = photon_engine::SqliteAdapter::connect("sqlite::memory:")
        .await
        .unwrap();

    run_storage_contract(adapter).await;
}
