use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, RwLock,
    },
};

use async_trait::async_trait;

use crate::{
    projection::apply_operation,
    storage::StorageAdapter,
    types::{
        unix_time_ms, CollectionName, Conflict, Operation, OperationFilter, OperationId,
        OperationStatus, Record, RecordId, RecordKey, RemoteId, ScopeId, Snapshot, SnapshotUpdate,
        StoredOperation, SyncCursor,
    },
    EngineError, Result,
};

#[derive(Clone, Debug, Default)]
pub struct MemoryAdapter {
    state: Arc<RwLock<MemoryState>>,
    sequence: Arc<AtomicI64>,
    /// Authority-side remote sequence. Kept apart from `sequence` so a local
    /// append never consumes a number the op-log hands out to every client.
    remote_sequence: Arc<AtomicI64>,
}

#[derive(Clone, Debug, Default)]
struct MemoryState {
    operations: BTreeMap<OperationId, StoredOperation>,
    operation_order: Vec<OperationId>,
    records: BTreeMap<RecordKey, Record>,
    snapshots: BTreeMap<RecordKey, Snapshot>,
    snapshot_updates: BTreeMap<(RecordKey, i64), SnapshotUpdate>,
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

    async fn append_authoritative_operation(
        &self,
        operation: Operation,
    ) -> Result<(StoredOperation, Record)> {
        // One write lock spans the id check, the sequence allocation, the
        // status flip and the projection, so a concurrent acceptance cannot
        // interleave. A shared database needs a database-side lock for the
        // same reason; see `StorageAdapter::append_authoritative_operation`.
        let mut state = self.write_state()?;

        if let Some(existing) = state.operations.get(&operation.id) {
            if !existing.operation.is_replay_of(&operation) {
                return Err(EngineError::Storage(format!(
                    "operation id {} was reused with a different payload",
                    operation.id
                )));
            }
            if existing.remote_sequence.is_some() {
                // Already accepted. Replaying the projection here would apply
                // a non-idempotent kind a second time.
                let stored = existing.clone();
                let record = match state.records.get(&stored.operation.key) {
                    Some(record) => record.clone(),
                    None => {
                        let record = apply_operation(None, &stored.operation)?;
                        state.records.insert(record.key.clone(), record.clone());
                        record
                    }
                };
                return Ok((stored, record));
            }
        }

        let remote_sequence = self.remote_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let projected = apply_operation(state.records.get(&operation.key).cloned(), &operation)?;

        let operation_id = operation.id.clone();
        let stored = match state.operations.get_mut(&operation_id) {
            Some(existing) => {
                // The payload is rewritten, not just the status: the row may
                // hold the unstamped copy this authority queued locally, and
                // `is_replay_of` deliberately ignores the audit key, so keeping
                // the stored payload would accept the operation while dropping
                // the audit record of who was authorized to push it.
                existing.operation = operation;
                existing.status = OperationStatus::Accepted;
                existing.remote_sequence = Some(remote_sequence);
                existing.clone()
            }
            None => {
                let stored = StoredOperation {
                    operation,
                    status: OperationStatus::Accepted,
                    local_sequence: self.sequence.fetch_add(1, Ordering::SeqCst) + 1,
                    remote_sequence: Some(remote_sequence),
                    received_at_ms: unix_time_ms(),
                };
                state.operation_order.push(stored.operation.id.clone());
                state
                    .operations
                    .insert(stored.operation.id.clone(), stored.clone());
                stored
            }
        };

        state
            .records
            .insert(projected.key.clone(), projected.clone());
        Ok((stored, projected))
    }

    async fn next_remote_sequence(&self) -> Result<i64> {
        Ok(self.remote_sequence.load(Ordering::SeqCst) + 1)
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
        // Paginate in the same order the cursor advances, like the SQL adapters
        // do. Insertion order and remote-sequence order diverge whenever the
        // authority hands out sequences in a different order than this store
        // appended the operations, and then a page cut in insertion order skips
        // or repeats operations.
        let order_by_remote_sequence = filter.after_remote_sequence.is_some();
        let mut matched: Vec<&StoredOperation> = Vec::new();

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

            matched.push(stored);

            // Insertion order is already the page order here, so a full page
            // means the walk is done -- no reason to scan the rest of the log.
            if !order_by_remote_sequence {
                if let Some(limit) = filter.limit {
                    if matched.len() >= limit {
                        break;
                    }
                }
            }
        }

        // An ordered page has to see every candidate before it knows which ones
        // it keeps, but only the kept ones are worth cloning.
        if order_by_remote_sequence {
            matched.sort_by_key(|stored| stored.remote_sequence.unwrap_or_default());
        }

        if let Some(limit) = filter.limit {
            matched.truncate(limit);
        }

        Ok(matched.into_iter().cloned().collect())
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

    async fn save_snapshot(&self, snapshot: Snapshot) -> Result<()> {
        let mut state = self.write_state()?;
        state.snapshots.insert(snapshot.key.clone(), snapshot);
        Ok(())
    }

    async fn get_snapshot(&self, key: &RecordKey) -> Result<Option<Snapshot>> {
        let state = self.read_state()?;
        Ok(state.snapshots.get(key).cloned())
    }

    async fn append_snapshot_update(&self, update: SnapshotUpdate) -> Result<()> {
        let mut state = self.write_state()?;
        state
            .snapshot_updates
            .entry((update.key.clone(), update.sequence))
            .or_insert(update);
        Ok(())
    }

    async fn list_snapshot_updates(
        &self,
        key: &RecordKey,
        after_sequence: i64,
    ) -> Result<Vec<SnapshotUpdate>> {
        let state = self.read_state()?;
        Ok(state
            .snapshot_updates
            .iter()
            .filter(|((update_key, sequence), _)| update_key == key && *sequence > after_sequence)
            .map(|(_, update)| update.clone())
            .collect())
    }

    async fn compact_snapshot_updates(&self, key: &RecordKey, up_to_sequence: i64) -> Result<()> {
        let mut state = self.write_state()?;
        state
            .snapshot_updates
            .retain(|(update_key, sequence), _| update_key != key || *sequence > up_to_sequence);
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
