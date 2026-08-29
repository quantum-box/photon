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

    run_authoritative_accept_contract(adapter).await;
}

/// What an authority must guarantee when it accepts an operation.
///
/// These hold for every adapter, which is the point: an in-process counter
/// satisfies the sequence assertions and fails the moment a second instance
/// shares the store, so the guarantee has to live in the adapter.
async fn run_authoritative_accept_contract<A>(adapter: A)
where
    A: StorageAdapter + Clone,
{
    let engine = PhotonEngine::new(adapter.clone());

    // Sequences start where the op-log left off and advance by one.
    let first_expected = adapter.next_remote_sequence().await.unwrap();
    let create = patch(
        "issue-authority",
        "authority-a",
        20,
        json!({ "title": "canonical payload" }),
    )
    .with_id("op-authority-create");
    let (accepted, projected) = adapter
        .append_authoritative_operation(create.clone())
        .await
        .unwrap();
    assert_eq!(accepted.status, OperationStatus::Accepted);
    assert_eq!(accepted.remote_sequence, Some(first_expected));
    assert_eq!(projected.value["title"], json!("canonical payload"));
    assert_eq!(
        adapter.next_remote_sequence().await.unwrap(),
        first_expected + 1,
        "an acceptance must consume exactly one sequence",
    );

    // A retry is the same acceptance, not a second one: same sequence, same
    // projection, and no sequence burned.
    let (retried, reprojected) = adapter
        .append_authoritative_operation(create.clone())
        .await
        .unwrap();
    assert_eq!(retried.remote_sequence, accepted.remote_sequence);
    assert_eq!(reprojected, projected);
    assert_eq!(
        adapter.next_remote_sequence().await.unwrap(),
        first_expected + 1,
        "replaying an accepted operation must not consume a sequence",
    );

    // The operation id is the idempotency key, so it must not be reusable for
    // different content — otherwise a retry could rewrite history in place.
    let mutated = patch(
        "issue-authority",
        "authority-a",
        20,
        json!({ "title": "mutated retry" }),
    )
    .with_id(create.id.clone());
    let error = adapter
        .append_authoritative_operation(mutated)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("was reused with a different payload"),
        "unexpected error: {error}",
    );
    let stored = adapter.get_operation(&create.id).await.unwrap().unwrap();
    assert_eq!(stored.operation, create);

    // Replay must not reach the projection twice. `Increment` is the kind that
    // makes this visible: re-applying it would silently double the field.
    let increment = Operation::new(
        key("issue-authority-counter"),
        ActorId::from("authority-a"),
        OperationKind::Increment {
            field: "points".to_owned(),
            by: 2,
        },
    )
    .with_id("op-authority-increment");
    let (_, once) = adapter
        .append_authoritative_operation(increment.clone())
        .await
        .unwrap();
    assert_eq!(once.value["points"], json!(2));
    let (_, twice) = adapter
        .append_authoritative_operation(increment.clone())
        .await
        .unwrap();
    assert_eq!(
        twice.value["points"],
        json!(2),
        "replaying an accepted increment must not apply it again",
    );

    // The engine wrapper reports the sequence storage actually assigned.
    let follow_up = patch(
        "issue-authority",
        "authority-b",
        30,
        json!({ "status": "done" }),
    )
    .with_id("op-authority-follow-up");
    let expected = adapter.next_remote_sequence().await.unwrap();
    let (record, remote_sequence) = engine
        .accept_authoritative_operation(follow_up)
        .await
        .unwrap();
    assert_eq!(remote_sequence, expected);
    assert_eq!(record.value["status"], json!("done"));
    assert_eq!(record.value["title"], json!("canonical payload"));
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

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_migrations_are_versioned_and_idempotent() {
    let adapter = photon_engine::SqliteAdapter::connect("sqlite::memory:")
        .await
        .unwrap();
    assert_eq!(adapter.schema_version().await.unwrap(), 2);

    // Re-running must be a no-op, not a failure or a duplicate version row.
    adapter.migrate().await.unwrap();
    assert_eq!(adapter.schema_version().await.unwrap(), 2);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM photon_engine_schema_migrations")
        .fetch_one(adapter.pool())
        .await
        .unwrap();
    assert_eq!(rows, 2);

    // A database that predates the authority sequence gets seeded past the
    // sequences its op-log already used, so migrating never reissues one.
    let next_sequence: i64 =
        sqlx::query_scalar("SELECT next_sequence FROM photon_engine_sync_state WHERE id = 1")
            .fetch_one(adapter.pool())
            .await
            .unwrap();
    assert_eq!(next_sequence, 1);
}

/// The guarantee an in-process counter cannot make.
///
/// Six independent adapters over one database file stand in for six replicas
/// over one server database. Each acceptance must still get its own sequence,
/// and every increment must land exactly once. With a per-process `AtomicI64`
/// this test hands the same sequence to several operations and loses writes.
#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_authority_sequence_is_serialized_across_instances() {
    const INSTANCES: usize = 6;

    let database_path = std::env::temp_dir().join(format!(
        "photon-authority-sequence-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let database_url = format!("sqlite:{}?mode=rwc", database_path.display());

    let mut engines = Vec::with_capacity(INSTANCES);
    for _ in 0..INSTANCES {
        engines.push(PhotonEngine::new(
            photon_engine::SqliteAdapter::connect(&database_url)
                .await
                .unwrap(),
        ));
    }

    let shared = RecordKey::new("workspace:authority", "counters", "shared");
    let mut handles = Vec::with_capacity(INSTANCES);
    for (index, engine) in engines.iter().enumerate() {
        let engine = engine.clone();
        let operation = Operation::new(
            shared.clone(),
            ActorId::from(format!("instance-{index}")),
            OperationKind::Increment {
                field: "count".to_owned(),
                by: 1,
            },
        )
        .with_id(format!("op-instance-{index}"))
        .with_timestamp(HybridTimestamp::new(10, 0, "shared-authority"));
        handles.push(tokio::spawn(async move {
            engine.accept_authoritative_operation(operation).await
        }));
    }

    let mut sequences = Vec::with_capacity(INSTANCES);
    for handle in handles {
        let (_record, remote_sequence) = handle
            .await
            .expect("acceptance task panicked")
            .expect("acceptance failed");
        sequences.push(remote_sequence);
    }
    sequences.sort_unstable();
    assert_eq!(
        sequences,
        (1..=INSTANCES as i64).collect::<Vec<_>>(),
        "every acceptance must get its own sequence, with no gaps",
    );

    let projected = engines[0].record(&shared).await.unwrap().unwrap();
    assert_eq!(
        projected.value["count"],
        json!(INSTANCES),
        "every increment must land exactly once",
    );
    assert_eq!(
        engines[0].next_remote_sequence().await.unwrap(),
        INSTANCES as i64 + 1,
    );

    drop(engines);
    let _ = std::fs::remove_file(&database_path);
    let _ = std::fs::remove_file(database_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(database_path.with_extension("db-wal"));
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

    // Version tracking: connect() migrated, a second run is a no-op.
    assert_eq!(adapter.schema_version().await.unwrap(), 1);
    adapter.migrate().await.unwrap();
    assert_eq!(adapter.schema_version().await.unwrap(), 1);

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
