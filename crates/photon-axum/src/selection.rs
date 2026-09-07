use super::*;
use photon_engine::{selection::RecordCheckpoint, RecordSelection};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionCursor {
    scope: ScopeId,
    selector: RecordSelection,
    phase: String,
    position: i64,
    after_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionRequest {
    scope: ScopeId,
    selector: RecordSelection,
    cursor: Option<SelectionCursor>,
    limit: usize,
    #[serde(default)]
    pending_operations: Vec<Operation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionResponse {
    records: Vec<RecordCheckpoint>,
    receipts: Vec<Receipt>,
    removals: Vec<Removal>,
    cursor: SelectionCursor,
    has_more: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    operation_id: String,
    remote_sequence: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Removal {
    record_id: String,
    reason: &'static str,
}

pub async fn pull_selection(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SelectionRequest>,
) -> Result<Json<SelectionResponse>, AppError> {
    let (grant, workspace) = authorize_scoped_request(&state, &headers, &payload.scope)?;
    payload
        .selector
        .validate()
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    if payload.limit == 0 || payload.limit > 1000 {
        return Err(AppError::BadRequest(
            "selection limit must be 1..=1000".into(),
        ));
    }
    if payload.pending_operations.len() > 1000
        || payload
            .pending_operations
            .iter()
            .any(|op| op.key.scope != payload.scope)
    {
        return Err(AppError::BadRequest("invalid pending operations".into()));
    }
    let store = state.engine.storage();
    let mut cursor = if let Some(cursor) = payload.cursor {
        if cursor.scope != payload.scope
            || cursor.selector != payload.selector
            || cursor.position < 0
            || !["snapshot", "delta"].contains(&cursor.phase.as_str())
            || (cursor.phase == "delta" && cursor.after_id.is_some())
        {
            return Err(AppError::BadRequest(
                "cursor does not belong to this selection".into(),
            ));
        }
        cursor
    } else {
        // This precedes the first snapshot query. Writes racing any snapshot
        // page are replayed from here, including new IDs before the keyset.
        SelectionCursor {
            scope: payload.scope.clone(),
            selector: payload.selector.clone(),
            phase: "snapshot".into(),
            position: store.next_remote_sequence().await? - 1,
            after_id: None,
        }
    };
    let mut records = Vec::new();
    let mut removals = Vec::new();
    let has_more;
    if cursor.phase == "snapshot" {
        let mut page = store
            .select_records(
                &payload.scope,
                &payload.selector,
                cursor.after_id.as_deref(),
                payload.limit + 1,
            )
            .await?;
        let another_page = page.len() > payload.limit;
        page.truncate(payload.limit);
        if let Some(last) = page.last() {
            cursor.after_id = Some(last.key.record_id.to_string());
        }
        for candidate in page {
            if let Some(checkpoint) = store.get_record_checkpoint(&candidate.key).await? {
                if state
                    .policy
                    .authorize_read(&grant, &workspace, &checkpoint.record)
                    .await
                    && payload.selector.matches(&checkpoint.record)
                {
                    records.push(checkpoint);
                }
            }
        }
        if !another_page {
            cursor.phase = "delta".into();
            cursor.after_id = None;
        }
        // Always catch up from the snapshot high-watermark before declaring
        // complete, including when the selected snapshot is empty.
        has_more = true;
    } else {
        // Bound the op-log scan as well as the response. No full collection
        // replay, and updates moving *out* of the predicate are still seen.
        let high_watermark = store.next_remote_sequence().await? - 1;
        let operations = store
            .list_operations(OperationFilter {
                scope: Some(payload.scope.clone()),
                collection: Some(payload.selector.collection.clone()),
                status: Some(OperationStatus::Accepted),
                after_remote_sequence: Some(cursor.position),
                limit: Some(payload.limit),
            })
            .await?;
        has_more = operations.len() == payload.limit;
        let mut keys = std::collections::BTreeSet::new();
        for stored in operations {
            if let Some(sequence) = stored.remote_sequence {
                cursor.position = cursor.position.max(sequence);
            }
            keys.insert(stored.operation.key);
        }
        // Empty pages still advance; persisting that cursor prevents scanning
        // an unrelated collection's history on every poll.
        if !has_more {
            cursor.position = cursor.position.max(high_watermark);
        }
        for key in keys {
            // ID-only interests must not reveal any unrelated IDs, even in
            // removal notifications.
            if payload
                .selector
                .record_ids
                .as_ref()
                .is_some_and(|ids| !ids.iter().any(|id| id == key.record_id.as_str()))
            {
                continue;
            }
            let record = store.get_record_checkpoint(&key).await?;
            let reason = match record {
                None => "deleted",
                Some(checkpoint) => {
                    let record = &checkpoint.record;
                    if !state
                        .policy
                        .authorize_read(&grant, &workspace, record)
                        .await
                    {
                        "revoked"
                    } else if record.deleted_at.is_some() {
                        "deleted"
                    } else if !payload.selector.matches(record) {
                        "out_of_scope"
                    } else {
                        records.push(checkpoint);
                        continue;
                    }
                }
            };
            removals.push(Removal {
                record_id: key.record_id.to_string(),
                reason,
            });
        }
    }
    let mut receipts = Vec::new();
    for operation in &payload.pending_operations {
        if let Some(stored) = store.get_operation(&operation.id).await? {
            if stored.operation.is_replay_of(operation) {
                if let Some(remote_sequence) = stored.remote_sequence {
                    receipts.push(Receipt {
                        operation_id: operation.id.to_string(),
                        remote_sequence,
                    });
                }
            }
        }
    }
    // Never split an atomic acknowledgement when a request's pending budget
    // contains only part of a batch.
    let accepted_ids: std::collections::BTreeSet<_> =
        receipts.iter().map(|r| r.operation_id.clone()).collect();
    receipts.retain(|receipt| {
        let operation = payload
            .pending_operations
            .iter()
            .find(|op| op.id.as_str() == receipt.operation_id)
            .unwrap();
        operation
            .metadata
            .get("photon_batch")
            .and_then(|b| b.get("operationIds"))
            .and_then(|v| v.as_array())
            .is_none_or(|ids| {
                ids.iter()
                    .all(|id| id.as_str().is_some_and(|id| accepted_ids.contains(id)))
            })
    });
    Ok(Json(SelectionResponse {
        records,
        removals,
        receipts,
        cursor,
        has_more,
    }))
}
