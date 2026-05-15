use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, RwLock,
    },
};

use async_trait::async_trait;

use crate::{
    storage::StorageAdapter,
    types::{
        unix_time_ms, CollectionName, Conflict, Operation, OperationFilter, OperationId,
        OperationStatus, Record, RecordId, RecordKey, RemoteId, ScopeId, StoredOperation,
        SyncCursor,
    },
    EngineError, Result,
};

#[derive(Clone, Debug, Default)]
pub struct MemoryAdapter {
    state: Arc<RwLock<MemoryState>>,
    sequence: Arc<AtomicI64>,
}

#[derive(Clone, Debug, Default)]
struct MemoryState {
    operations: BTreeMap<OperationId, StoredOperation>,
    operation_order: Vec<OperationId>,
    records: BTreeMap<RecordKey, Record>,
    cursors: BTreeMap<(ScopeId, RemoteId), SyncCursor>,
    conflicts: BTreeMap<crate::ConflictId, Conflict>,
}

impl MemoryAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    fn read_state(&self) -> Result<std::sync::RwLockReadGuard<'_, MemoryState>> {
        self.state
            .read()
            .map_err(|_| EngineError::Storage("memory adapter read lock poisoned".to_owned()))
    }

    fn write_state(&self) -> Result<std::sync::RwLockWriteGuard<'_, MemoryState>> {
        self.state
            .write()
            .map_err(|_| EngineError::Storage("memory adapter write lock poisoned".to_owned()))
    }
}

#[async_trait]
impl StorageAdapter for MemoryAdapter {
    async fn append_operation(
        &self,
        operation: Operation,
        status: OperationStatus,
    ) -> Result<StoredOperation> {
        let mut state = self.write_state()?;

        if let Some(existing) = state.operations.get(&operation.id) {
            return Ok(existing.clone());
        }

        let stored = StoredOperation {
            operation,
            status,
            local_sequence: self.sequence.fetch_add(1, Ordering::SeqCst) + 1,
            remote_sequence: None,
            received_at_ms: unix_time_ms(),
        };

        state.operation_order.push(stored.operation.id.clone());
        state
            .operations
            .insert(stored.operation.id.clone(), stored.clone());

        Ok(stored)
    }

    async fn get_operation(&self, operation_id: &OperationId) -> Result<Option<StoredOperation>> {
        let state = self.read_state()?;
        Ok(state.operations.get(operation_id).cloned())
    }

    async fn mark_operation_status(
        &self,
        operation_id: &OperationId,
        status: OperationStatus,
        remote_sequence: Option<i64>,
    ) -> Result<()> {
        let mut state = self.write_state()?;

        if let Some(operation) = state.operations.get_mut(operation_id) {
            operation.status = status;
            if remote_sequence.is_some() {
                operation.remote_sequence = remote_sequence;
            }
        }

        Ok(())
    }

    async fn list_operations(&self, filter: OperationFilter) -> Result<Vec<StoredOperation>> {
        let state = self.read_state()?;
        let mut operations = Vec::new();

        for operation_id in &state.operation_order {
            let Some(stored) = state.operations.get(operation_id) else {
                continue;
            };

            if let Some(scope) = &filter.scope {
                if &stored.operation.key.scope != scope {
                    continue;
                }
            }

            if let Some(collection) = &filter.collection {
                if &stored.operation.key.collection != collection {
                    continue;
                }
            }

            if let Some(status) = &filter.status {
                if &stored.status != status {
                    continue;
                }
            }

            if let Some(after_remote_sequence) = filter.after_remote_sequence {
                if stored.remote_sequence.unwrap_or_default() <= after_remote_sequence {
                    continue;
                }
            }

            operations.push(stored.clone());

            if let Some(limit) = filter.limit {
                if operations.len() >= limit {
                    break;
                }
            }
        }

        Ok(operations)
    }

    async fn upsert_record(&self, record: Record) -> Result<()> {
        let mut state = self.write_state()?;
        state.records.insert(record.key.clone(), record);
        Ok(())
    }

    async fn get_record(&self, key: &RecordKey) -> Result<Option<Record>> {
        let state = self.read_state()?;
        Ok(state.records.get(key).cloned())
    }

    async fn list_records(
        &self,
        scope: &ScopeId,
        collection: &CollectionName,
    ) -> Result<Vec<Record>> {
        let state = self.read_state()?;

        Ok(state
            .records
            .values()
            .filter(|record| &record.key.scope == scope && &record.key.collection == collection)
            .cloned()
            .collect())
    }

    async fn delete_record_projection(&self, key: &RecordKey) -> Result<()> {
        let mut state = self.write_state()?;
        state.records.remove(key);
        Ok(())
    }

    async fn save_cursor(&self, cursor: SyncCursor) -> Result<()> {
        let mut state = self.write_state()?;
        state
            .cursors
            .insert((cursor.scope.clone(), cursor.remote.clone()), cursor);
        Ok(())
    }

    async fn get_cursor(&self, scope: &ScopeId, remote: &RemoteId) -> Result<Option<SyncCursor>> {
        let state = self.read_state()?;
        Ok(state.cursors.get(&(scope.clone(), remote.clone())).cloned())
    }

    async fn save_conflict(&self, conflict: Conflict) -> Result<()> {
        let mut state = self.write_state()?;
        state.conflicts.insert(conflict.id.clone(), conflict);
        Ok(())
    }

    async fn list_conflicts(
        &self,
        scope: &ScopeId,
        collection: Option<&CollectionName>,
        record_id: Option<&RecordId>,
    ) -> Result<Vec<Conflict>> {
        let state = self.read_state()?;

        Ok(state
            .conflicts
            .values()
            .filter(|conflict| &conflict.key.scope == scope)
            .filter(|conflict| {
                collection
                    .map(|collection| &conflict.key.collection == collection)
                    .unwrap_or(true)
            })
            .filter(|conflict| {
                record_id
                    .map(|record_id| &conflict.key.record_id == record_id)
                    .unwrap_or(true)
            })
            .cloned()
            .collect())
    }
}
