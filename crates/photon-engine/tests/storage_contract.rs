use std::collections::BTreeMap;

use photon_engine::{
    ActorId, CollectionName, Conflict, HybridTimestamp, MemoryAdapter, Operation, OperationFilter,
    OperationKind, OperationStatus, PhotonEngine, RecordKey, RemoteId, ScopeId, Snapshot,
    SnapshotUpdate, StorageAdapter, SyncCursor,
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

    let snapshot_key = RecordKey::new("workspace:test", "yjs_documents", "doc-1");
    let first_update = SnapshotUpdate::new(snapshot_key.clone(), 1, vec![1, 2, 3], "yjs-update-v1")
        .with_metadata(json!({ "room": "doc-1" }));
    adapter
        .append_snapshot_update(first_update.clone())
        .await
        .unwrap();
    adapter
        .append_snapshot_update(first_update.clone())
        .await
        .unwrap();
    adapter
        .append_snapshot_update(SnapshotUpdate::new(
            snapshot_key.clone(),
            2,
            vec![4, 5],
            "yjs-update-v1",
        ))
        .await
        .unwrap();
    let updates = adapter
        .list_snapshot_updates(&snapshot_key, 0)
        .await
        .unwrap();
    assert_eq!(updates.len(), 2);
    assert_eq!(updates[0], first_update);

    let snapshot = Snapshot::new(snapshot_key.clone(), 2, vec![9, 9, 9], "yjs-state-v1")
        .with_metadata(json!({ "compacted": true }));
    adapter.save_snapshot(snapshot.clone()).await.unwrap();
    let loaded_snapshot = adapter.get_snapshot(&snapshot_key).await.unwrap();
    assert_eq!(loaded_snapshot, Some(snapshot));

    adapter
        .compact_snapshot_updates(&snapshot_key, 1)
        .await
        .unwrap();
    let remaining_updates = adapter
        .list_snapshot_updates(&snapshot_key, 0)
        .await
        .unwrap();
    assert_eq!(remaining_updates.len(), 1);
    assert_eq!(remaining_updates[0].sequence, 2);
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

#[cfg(feature = "mysql")]
#[tokio::test]
async fn mysql_adapter_satisfies_storage_contract_when_url_is_configured() {
    let Ok(database_url) = std::env::var("PHOTON_ENGINE_MYSQL_TEST_DATABASE_URL") else {
        eprintln!(
            "skipping MySQL storage contract: PHOTON_ENGINE_MYSQL_TEST_DATABASE_URL is unset"
        );
        return;
    };

    let adapter = photon_engine::MySqlAdapter::connect(&database_url)
        .await
        .unwrap();
    reset_mysql_storage(&adapter).await;
    run_storage_contract(adapter.clone()).await;
    reset_mysql_storage(&adapter).await;
}

#[cfg(feature = "mysql")]
async fn reset_mysql_storage(adapter: &photon_engine::MySqlAdapter) {
    for table in [
        "photon_engine_snapshot_updates",
        "photon_engine_snapshots",
        "photon_engine_conflicts",
        "photon_engine_cursors",
        "photon_engine_records",
        "photon_engine_operations",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(adapter.pool())
            .await
            .unwrap();
    }
}
