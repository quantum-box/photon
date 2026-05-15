use serde_json::{Map, Value};

use crate::{
    types::{ActorId, Operation, OperationKind, Record},
    EngineError, Result,
};

pub fn apply_operation(current: Option<Record>, operation: &Operation) -> Result<Record> {
    let mut record = current.unwrap_or_else(|| {
        Record::new(
            operation.key.clone(),
            Value::Object(Map::new()),
            operation.timestamp.clone(),
            operation.actor_id.clone(),
        )
    });

    if record.is_deleted()
        && !matches!(
            operation.kind,
            OperationKind::Restore { .. } | OperationKind::Delete
        )
    {
        return Ok(record);
    }

    match &operation.kind {
        OperationKind::Upsert { value } => {
            if operation.timestamp >= record.version {
                record = Record::new(
                    operation.key.clone(),
                    value.clone(),
                    operation.timestamp.clone(),
                    operation.actor_id.clone(),
                );
            }
        }
        OperationKind::Patch { fields } => {
            let object = ensure_object(&mut record.value)?;
            let mut changed = false;

            for (field, value) in fields {
                let should_apply = record
                    .field_versions
                    .get(field)
                    .map(|version| operation.timestamp >= *version)
                    .unwrap_or(true);

                if should_apply {
                    object.insert(field.clone(), value.clone());
                    record
                        .field_versions
                        .insert(field.clone(), operation.timestamp.clone());
                    changed = true;
                }
            }

            if changed {
                touch(&mut record, &operation.timestamp, &operation.actor_id);
            }
        }
        OperationKind::RemoveFields { fields } => {
            let object = ensure_object(&mut record.value)?;
            let mut changed = false;

            for field in fields {
                let should_apply = record
                    .field_versions
                    .get(field)
                    .map(|version| operation.timestamp >= *version)
                    .unwrap_or(true);

                if should_apply {
                    object.remove(field);
                    record
                        .field_versions
                        .insert(field.clone(), operation.timestamp.clone());
                    changed = true;
                }
            }

            if changed {
                touch(&mut record, &operation.timestamp, &operation.actor_id);
            }
        }
        OperationKind::Delete => {
            let should_delete = record
                .deleted_at
                .as_ref()
                .map(|deleted_at| operation.timestamp >= *deleted_at)
                .unwrap_or_else(|| operation.timestamp >= record.version);

            if should_delete {
                record.deleted_at = Some(operation.timestamp.clone());
                touch(&mut record, &operation.timestamp, &operation.actor_id);
            }
        }
        OperationKind::Restore { value } => {
            let should_restore = record
                .deleted_at
                .as_ref()
                .map(|deleted_at| operation.timestamp >= *deleted_at)
                .unwrap_or_else(|| operation.timestamp >= record.version);

            if should_restore {
                if let Some(value) = value {
                    record = Record::new(
                        operation.key.clone(),
                        value.clone(),
                        operation.timestamp.clone(),
                        operation.actor_id.clone(),
                    );
                } else {
                    record.deleted_at = None;
                    touch(&mut record, &operation.timestamp, &operation.actor_id);
                }
            }
        }
        OperationKind::Increment { field, by } => {
            if should_apply_field(&record, field, operation) {
                let object = ensure_object(&mut record.value)?;
                let current = object
                    .get(field)
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                object.insert(field.clone(), Value::from(current + by));
                record
                    .field_versions
                    .insert(field.clone(), operation.timestamp.clone());
                touch(&mut record, &operation.timestamp, &operation.actor_id);
            }
        }
        OperationKind::SetAdd { field, values } => {
            if should_apply_field(&record, field, operation) {
                let object = ensure_object(&mut record.value)?;
                let mut set_values = object
                    .get(field)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();

                for value in values {
                    if !set_values.contains(value) {
                        set_values.push(value.clone());
                    }
                }

                set_values.sort_by_key(canonical_json_key);
                object.insert(field.clone(), Value::Array(set_values));
                record
                    .field_versions
                    .insert(field.clone(), operation.timestamp.clone());
                touch(&mut record, &operation.timestamp, &operation.actor_id);
            }
        }
        OperationKind::SetRemove { field, values } => {
            let should_apply = record
                .field_versions
                .get(field)
                .map(|version| {
                    happened_after_without_actor_tie_break(&operation.timestamp, version)
                })
                .unwrap_or(true);

            if should_apply {
                let object = ensure_object(&mut record.value)?;
                let mut set_values = object
                    .get(field)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();

                set_values.retain(|value| !values.contains(value));
                set_values.sort_by_key(canonical_json_key);
                object.insert(field.clone(), Value::Array(set_values));
                record
                    .field_versions
                    .insert(field.clone(), operation.timestamp.clone());
                touch(&mut record, &operation.timestamp, &operation.actor_id);
            }
        }
    }

    Ok(record)
}

fn ensure_object(value: &mut Value) -> Result<&mut Map<String, Value>> {
    value.as_object_mut().ok_or(EngineError::InvalidRecordValue)
}

fn should_apply_field(record: &Record, field: &str, operation: &Operation) -> bool {
    record
        .field_versions
        .get(field)
        .map(|version| operation.timestamp >= *version)
        .unwrap_or(true)
}

fn touch(record: &mut Record, timestamp: &crate::HybridTimestamp, actor_id: &ActorId) {
    if timestamp >= &record.version {
        record.version = timestamp.clone();
        record.updated_by = actor_id.clone();
    }
}

fn happened_after_without_actor_tie_break(
    candidate: &crate::HybridTimestamp,
    current: &crate::HybridTimestamp,
) -> bool {
    candidate.wall_time_ms > current.wall_time_ms
        || (candidate.wall_time_ms == current.wall_time_ms && candidate.counter > current.counter)
}

fn canonical_json_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("{value:?}"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::apply_operation;
    use crate::{ActorId, HybridTimestamp, Operation, OperationKind, RecordKey};

    fn key() -> RecordKey {
        RecordKey::new("workspace:local", "issues", "issue-1")
    }

    fn patch(actor: &str, wall_time_ms: i64, fields: serde_json::Value) -> Operation {
        let fields = fields
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();

        Operation::new(key(), ActorId::from(actor), OperationKind::Patch { fields })
            .with_timestamp(HybridTimestamp::new(wall_time_ms, 0, actor))
    }

    #[test]
    fn scalar_fields_are_last_write_wins_with_actor_tie_break() {
        let first = patch("actor-a", 10, json!({ "title": "first" }));
        let second = patch("actor-b", 10, json!({ "title": "second" }));

        let record = apply_operation(None, &first).unwrap();
        let record = apply_operation(Some(record), &second).unwrap();

        assert_eq!(record.value["title"], json!("second"));
    }

    #[test]
    fn tombstone_blocks_later_update_until_explicit_restore() {
        let create = patch("actor-a", 10, json!({ "title": "live" }));
        let delete = Operation::new(key(), "actor-a", OperationKind::Delete)
            .with_timestamp(HybridTimestamp::new(11, 0, "actor-a"));
        let update_after_delete = patch("actor-b", 12, json!({ "title": "stale edit" }));
        let restore = Operation::new(
            key(),
            "actor-b",
            OperationKind::Restore {
                value: Some(json!({ "title": "restored" })),
            },
        )
        .with_timestamp(HybridTimestamp::new(13, 0, "actor-b"));

        let record = apply_operation(None, &create).unwrap();
        let record = apply_operation(Some(record), &delete).unwrap();
        let record = apply_operation(Some(record), &update_after_delete).unwrap();

        assert!(record.is_deleted());
        assert_eq!(record.value["title"], json!("live"));

        let record = apply_operation(Some(record), &restore).unwrap();
        assert!(!record.is_deleted());
        assert_eq!(record.value["title"], json!("restored"));
    }

    #[test]
    fn set_add_wins_over_concurrent_remove() {
        let add = Operation::new(
            key(),
            "actor-a",
            OperationKind::SetAdd {
                field: "labels".to_owned(),
                values: vec![json!("sync")],
            },
        )
        .with_timestamp(HybridTimestamp::new(10, 0, "actor-a"));
        let remove = Operation::new(
            key(),
            "actor-b",
            OperationKind::SetRemove {
                field: "labels".to_owned(),
                values: vec![json!("sync")],
            },
        )
        .with_timestamp(HybridTimestamp::new(10, 0, "actor-b"));

        let record = apply_operation(None, &add).unwrap();
        let record = apply_operation(Some(record), &remove).unwrap();

        assert_eq!(record.value["labels"], json!(["sync"]));
    }

    #[test]
    fn counter_operations_compose_instead_of_replacing() {
        let first = Operation::new(
            key(),
            "actor-a",
            OperationKind::Increment {
                field: "points".to_owned(),
                by: 2,
            },
        )
        .with_timestamp(HybridTimestamp::new(10, 0, "actor-a"));
        let second = Operation::new(
            key(),
            "actor-b",
            OperationKind::Increment {
                field: "points".to_owned(),
                by: 3,
            },
        )
        .with_timestamp(HybridTimestamp::new(10, 0, "actor-b"));

        let record = apply_operation(None, &first).unwrap();
        let record = apply_operation(Some(record), &second).unwrap();

        assert_eq!(record.value["points"], json!(5));
    }
}
