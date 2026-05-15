use async_trait::async_trait;

use crate::{
    types::{
        CollectionName, Conflict, Operation, OperationFilter, OperationId, OperationStatus, Record,
        RecordId, RecordKey, RemoteId, ScopeId, StoredOperation, SyncCursor,
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
