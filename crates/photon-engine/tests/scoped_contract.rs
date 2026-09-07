use photon_engine::{MemoryAdapter, Operation, OperationKind, RecordKey, StorageAdapter};
use serde_json::json;

fn op(id: &str, record: &str, value: serde_json::Value) -> Operation {
    Operation::new(
        RecordKey::new("tenant:test:workspace:main", "rows", record),
        "test",
        OperationKind::Upsert { value },
    )
    .with_id(id)
}

async fn contract(store: &impl StorageAdapter) {
    use photon_engine::selection::{RecordSelection, SelectionFilter};
    let scope = "tenant:test:workspace:main".into();
    let originals = vec![
        op("a", "a", json!({"region":"east", "n":1, "nil": null})),
        op("b", "b", json!({"region":"west", "n":2})),
        op("c", "c", json!({"region":"east", "n":3})),
    ];
    store
        .append_authoritative_batch(originals.clone())
        .await
        .unwrap();
    let select = RecordSelection {
        collection: "rows".into(),
        record_ids: None,
        filters: Some(vec![SelectionFilter {
            field: "region".into(),
            op: "eq".into(),
            value: json!("east"),
        }]),
    };
    let page = store
        .select_records(&scope, &select, None, 1)
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].key.record_id.as_str(), "a");
    let page = store
        .select_records(&scope, &select, Some("a"), 2)
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].key.record_id.as_str(), "c");
    assert!(store
        .select_records(&"tenant:other:workspace:main".into(), &select, None, 10)
        .await
        .unwrap()
        .is_empty());
    for (field, operator, value, expected) in [
        ("n", "gte", json!(2), vec!["b", "c"]),
        ("n", "eq", json!(1.0), vec!["a"]),
        ("nil", "eq", json!(null), vec!["a"]),
        ("nil", "ne", json!(null), vec!["b", "c"]),
        ("nil", "exists", json!(true), vec!["a"]),
        ("region", "in", json!(["east"]), vec!["a", "c"]),
        ("region", "in", json!([]), vec![]),
        ("n", "gt", json!("0"), vec![]),
    ] {
        let selection = RecordSelection {
            filters: Some(vec![SelectionFilter {
                field: field.into(),
                op: operator.into(),
                value,
            }]),
            ..select.clone()
        };
        let rows = store
            .select_records(&scope, &selection, None, 10)
            .await
            .unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r.key.record_id.as_str())
                .collect::<Vec<_>>(),
            expected,
            "{field} {operator}"
        );
    }
    let id_only = RecordSelection {
        record_ids: Some(vec!["b".into()]),
        filters: None,
        ..select.clone()
    };
    assert_eq!(
        store
            .select_records(&scope, &id_only, None, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    let checkpoint = store
        .get_record_checkpoint(&originals[0].key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.sequence, 1);
    // Duplicate delivery consumes neither a second sequence nor an increment.
    let increment = Operation::new(
        originals[0].key.clone(),
        "test",
        OperationKind::Increment {
            field: "n".into(),
            by: 1,
        },
    )
    .with_id("inc");
    let batch = vec![increment.clone(), op("d", "d", json!({"n":4}))];
    store
        .append_authoritative_batch(batch.clone())
        .await
        .unwrap();
    let sequence = store.next_remote_sequence().await.unwrap();
    store.append_authoritative_batch(batch).await.unwrap();
    assert_eq!(store.next_remote_sequence().await.unwrap(), sequence);
    assert_eq!(
        store
            .get_record(&originals[0].key)
            .await
            .unwrap()
            .unwrap()
            .value["n"],
        2
    );
    // A failure after the first staged write rolls back records AND sequences.
    let bad = op("a", "a", json!({"different":true}));
    assert!(store
        .append_authoritative_batch(vec![op("must-rollback", "rollback", json!({})), bad])
        .await
        .is_err());
    assert!(store
        .get_operation(&"must-rollback".into())
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_record(&RecordKey::new(scope.clone(), "rows", "rollback"))
        .await
        .unwrap()
        .is_none());
    assert_eq!(store.next_remote_sequence().await.unwrap(), sequence);
}

#[tokio::test]
async fn memory_scoped_and_atomic_contract() {
    contract(&MemoryAdapter::new()).await;
}

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_scoped_and_atomic_contract() {
    let store = photon_engine::SqliteAdapter::connect("sqlite::memory:")
        .await
        .unwrap();
    store.migrate().await.unwrap();
    contract(&store).await;
}

#[cfg(feature = "mysql")]
#[tokio::test]
async fn mysql_scoped_and_atomic_contract() {
    // Use a dedicated disposable database, never the application's database.
    let Ok(url) = std::env::var("PHOTON_SCOPED_TEST_MYSQL_URL") else {
        return;
    };
    let store = photon_engine::MySqlAdapter::connect(&url).await.unwrap();
    store.migrate().await.unwrap();
    contract(&store).await;
}
