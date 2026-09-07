async fn scoped_post(
    app: Router,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| serde_json::json!({"message": String::from_utf8_lossy(&bytes)}));
    (status, value)
}

#[tokio::test]
async fn scoped_http_pages_and_catches_writes_before_the_snapshot_keyset() {
    let (app, state) = engine_test_app().await;
    let scope = "tenant:test:workspace:main";
    let operation = |id: &str, region: &str| {
        Operation::new(
            RecordKey::new(scope, "records", id),
            "test",
            OperationKind::Upsert {
                value: serde_json::json!({"region":region}),
            },
        )
    };
    for id in ["b", "d", "z"] {
        state
            .engine
            .accept_authoritative_operation(operation(id, if id == "z" { "west" } else { "east" }))
            .await
            .unwrap();
    }
    let selector = serde_json::json!({"collection":"records", "filters":[{"field":"region", "op":"eq", "value":"east"}]});
    let (status, page) = scoped_post(
        app.clone(),
        "/api/engine/selection",
        serde_json::json!({"scope":scope,"selector":selector,"cursor":null,"limit":1}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["records"][0]["record"]["key"]["record_id"], "b");
    assert_eq!(page["cursor"]["phase"], "snapshot");
    // Inserting before the keyset while paging cannot be lost: it must appear
    // in the delta phase from the initial high watermark.
    state
        .engine
        .accept_authoritative_operation(operation("a", "east"))
        .await
        .unwrap();
    state
        .engine
        .accept_authoritative_operation(operation("b", "west"))
        .await
        .unwrap();
    let mut cursor = page["cursor"].clone();
    let mut ids = Vec::new();
    let mut removed = Vec::new();
    for _ in 0..10 {
        let (status, page) = scoped_post(
            app.clone(),
            "/api/engine/selection",
            serde_json::json!({"scope":scope,"selector":selector,"cursor":cursor,"limit":1,"knownRecordIds":["b"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        ids.extend(
            page["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["record"]["key"]["record_id"].as_str().unwrap().to_owned()),
        );
        removed.extend(page["removals"].as_array().unwrap().iter().cloned());
        cursor = page["cursor"].clone();
        if page["hasMore"] == false {
            break;
        }
    }
    assert!(ids.contains(&"a".to_owned()));
    assert!(ids.contains(&"d".to_owned()));
    assert!(!ids.contains(&"z".to_owned()));
    assert!(removed.contains(&serde_json::json!({"recordId":"b","reason":"out_of_scope"})));
    let (status, _) = scoped_post(app, "/api/engine/selection", serde_json::json!({"scope":scope,"selector":{"collection":"other"},"cursor":cursor,"limit":1})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn atomic_http_retries_and_rejects_a_downgrade_to_regular_push() {
    let (app, state) = engine_test_app().await;
    let scope = "tenant:test:workspace:main";
    let batch = serde_json::json!({"id":"b1","operationIds":["a","b"]});
    let operations: Vec<_> = ["a", "b"]
        .iter()
        .map(|id| {
            Operation::new(
                RecordKey::new(scope, "rows", *id),
                "test",
                OperationKind::Increment {
                    field: "n".into(),
                    by: 1,
                },
            )
            .with_id(*id)
            .with_metadata(serde_json::json!({"photon_batch":batch}))
        })
        .collect();
    let body = serde_json::json!({"scope":scope,"batch_id":"b1","operations":operations});
    let (status, first) = scoped_post(app.clone(), "/api/engine/push-atomic", body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, retry) = scoped_post(app.clone(), "/api/engine/push-atomic", body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["decisions"], retry["decisions"]);
    assert_eq!(
        state
            .engine
            .record(&operations[0].key)
            .await
            .unwrap()
            .unwrap()
            .value["n"],
        1
    );
    let (status, _) = scoped_post(
        app.clone(),
        "/api/engine/push",
        serde_json::json!({"scope":scope,"operations":operations}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = scoped_post(
        app,
        "/api/engine/push-atomic",
        serde_json::json!({"scope":scope,"batch_id":"b1","operations":[operations[0]]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn atomic_http_rejects_all_members_when_one_policy_check_fails() {
    struct DenySecond;
    #[async_trait]
    impl EnginePolicy for DenySecond {
        async fn authorize_operation(&self, ctx: OperationContext<'_>) -> PolicyVerdict {
            if ctx.operation.key.record_id.as_str() == "b" {
                PolicyVerdict::Reject {
                    reason: "denied".into(),
                }
            } else {
                PolicyVerdict::Allow
            }
        }
    }
    let state = test_state_with(AuthConfig::disabled(), Arc::new(DenySecond)).await;
    let app = engine_routes().with_state(state.clone());
    let scope = "tenant:test:workspace:main";
    let operations: Vec<_> = ["a", "b"]
        .iter()
        .map(|id| {
            Operation::new(
                RecordKey::new(scope, "rows", *id),
                "test",
                OperationKind::Upsert {
                    value: serde_json::json!({}),
                },
            )
            .with_id(*id)
            .with_metadata(serde_json::json!({"photon_batch":{"id":"b1","operationIds":["a","b"]}}))
        })
        .collect();
    let (status, body) = scoped_post(
        app,
        "/api/engine/push-atomic",
        serde_json::json!({"scope":scope,"batch_id":"b1","operations":operations}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["type"] == "rejected"));
    assert!(state
        .engine
        .record(&operations[0].key)
        .await
        .unwrap()
        .is_none());
    assert_eq!(state.engine.next_remote_sequence().await.unwrap(), 1);
}

#[tokio::test]
async fn scoped_revocations_only_name_caller_known_ids_and_recheck_held_ids() {
    struct ReadPolicy;
    #[async_trait]
    impl EnginePolicy for ReadPolicy {
        async fn authorize_operation(&self, _: OperationContext<'_>) -> PolicyVerdict {
            PolicyVerdict::Allow
        }
        async fn authorize_read(
            &self,
            _: &crate::auth::TokenGrant,
            _: &crate::auth::WorkspaceScope,
            record: &photon_engine::Record,
        ) -> bool {
            record.value["visible"] == true
        }
    }
    let state = test_state_with(AuthConfig::disabled(), Arc::new(ReadPolicy)).await;
    let app = engine_routes().with_state(state.clone());
    let scope = "tenant:test:workspace:main";
    for id in ["never-seen", "previously-held"] {
        state
            .engine
            .accept_authoritative_operation(Operation::new(
                RecordKey::new(scope, "records", id),
                "test",
                OperationKind::Upsert {
                    value: serde_json::json!({"visible":false}),
                },
            ))
            .await
            .unwrap();
    }
    let selector = serde_json::json!({"collection":"records"});
    let cursor = serde_json::json!({"scope":scope,"selector":selector,"phase":"delta","position":0,"afterId":null});
    let (status, page) = scoped_post(
        app.clone(),
        "/api/engine/selection",
        serde_json::json!({"scope":scope,"selector":selector,"cursor":cursor,"limit":100}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page["records"].as_array().unwrap().is_empty());
    assert!(page["removals"].as_array().unwrap().is_empty());
    // The cursor already passed both writes. Held-ID validation still removes
    // the revoked record and never exposes the other, unknown record ID.
    let (status, checked) = scoped_post(app, "/api/engine/selection", serde_json::json!({"scope":scope,"selector":selector,"cursor":page["cursor"],"limit":100,"knownRecordIds":["previously-held"]})).await;
    assert_eq!(status, StatusCode::OK, "{checked}");
    assert_eq!(
        checked["removals"],
        serde_json::json!([{"recordId":"previously-held","reason":"revoked"}])
    );
}
