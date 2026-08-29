use async_trait::async_trait;

use crate::{
    types::{
        CollectionName, Conflict, Operation, OperationFilter, OperationId, OperationStatus, Record,
        RecordId, RecordKey, RemoteId, ScopeId, Snapshot, SnapshotUpdate, StoredOperation,
        SyncCursor,
    },
    Result,
};

#[async_trait]
pub trait StorageAdapter: Send + Sync {
    async fn append_operation(
        &self,
        operation: Operation,
        status: OperationStatus,
    ) -> Result<StoredOperation>;

    /// Accept one operation as the authority, atomically.
    ///
    /// In one serialized step this validates that the operation id has not
    /// been reused with a different payload, assigns the next remote sequence,
    /// persists the operation as `Accepted`, and updates its materialized
    /// record projection.
    ///
    /// The atomicity is the point. Allocating a sequence in the server process
    /// only holds while exactly one process is the authority; the moment a
    /// second replica, a second pod, or a second serverless invocation serves
    /// the same database, two acceptances hand out the same sequence — or
    /// commit out of sequence order, which makes a concurrent pull skip the
    /// not-yet-committed sequence forever. Implementations backed by a shared
    /// database must therefore serialize the whole acceptance in the database,
    /// not in the process.
    ///
    /// Replaying an already-accepted operation returns the stored operation
    /// and the current record unchanged. Re-projecting would be wrong, not
    /// merely wasteful: `OperationKind::Increment` is not idempotent, so a
    /// retried push must not reach the projection twice.
    async fn append_authoritative_operation(
        &self,
        operation: Operation,
    ) -> Result<(StoredOperation, Record)>;

    /// The remote sequence the next [`Self::append_authoritative_operation`]
    /// will assign. For reporting only — never allocate a sequence from it.
    async fn next_remote_sequence(&self) -> Result<i64>;

    async fn get_operation(&self, operation_id: &OperationId) -> Result<Option<StoredOperation>>;

    async fn mark_operation_status(
        &self,
        operation_id: &OperationId,
        status: OperationStatus,
        remote_sequence: Option<i64>,
    ) -> Result<()>;

    async fn list_operations(&self, filter: OperationFilter) -> Result<Vec<StoredOperation>>;

    async fn upsert_record(&self, record: Record) -> Result<()>;

    async fn get_record(&self, key: &RecordKey) -> Result<Option<Record>>;

    async fn list_records(
        &self,
        scope: &ScopeId,
        collection: &CollectionName,
    ) -> Result<Vec<Record>>;

    async fn delete_record_projection(&self, key: &RecordKey) -> Result<()>;

    async fn save_snapshot(&self, snapshot: Snapshot) -> Result<()>;

    async fn get_snapshot(&self, key: &RecordKey) -> Result<Option<Snapshot>>;

    async fn append_snapshot_update(&self, update: SnapshotUpdate) -> Result<()>;

    async fn list_snapshot_updates(
        &self,
        key: &RecordKey,
        after_sequence: i64,
    ) -> Result<Vec<SnapshotUpdate>>;

    async fn compact_snapshot_updates(&self, key: &RecordKey, up_to_sequence: i64) -> Result<()>;

    async fn save_cursor(&self, cursor: SyncCursor) -> Result<()>;

    async fn get_cursor(&self, scope: &ScopeId, remote: &RemoteId) -> Result<Option<SyncCursor>>;

    async fn save_conflict(&self, conflict: Conflict) -> Result<()>;

    async fn list_conflicts(
        &self,
        scope: &ScopeId,
        collection: Option<&CollectionName>,
        record_id: Option<&RecordId>,
    ) -> Result<Vec<Conflict>>;
}
