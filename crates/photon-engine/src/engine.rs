use std::collections::HashSet;

use crate::{
    projection::apply_operation,
    protocol::{PullRequest, PushDecision, PushRequest, SyncEndpoint, SyncSummary},
    storage::StorageAdapter,
    types::{
        Operation, OperationFilter, OperationId, OperationStatus, Record, RecordKey, RemoteId,
        ScopeId, SyncCursor,
    },
    Result,
};

#[derive(Clone, Debug)]
pub struct PhotonEngine<A> {
    storage: A,
}

impl<A> PhotonEngine<A> {
    pub fn new(storage: A) -> Self {
        Self { storage }
    }

    pub fn storage(&self) -> &A {
        &self.storage
    }
}

impl<A> PhotonEngine<A>
where
    A: StorageAdapter,
{
    pub async fn apply_local_operation(&self, operation: Operation) -> Result<Record> {
        self.storage
            .append_operation(operation.clone(), OperationStatus::Pending)
            .await?;
        self.apply_to_projection(&operation).await
    }

    pub async fn apply_remote_operation(
        &self,
        operation: Operation,
        remote_sequence: i64,
    ) -> Result<Record> {
        self.storage
            .append_operation(operation.clone(), OperationStatus::Accepted)
            .await?;
        self.storage
            .mark_operation_status(
                &operation.id,
                OperationStatus::Accepted,
                Some(remote_sequence),
            )
            .await?;
        self.apply_to_projection(&operation).await
    }

    pub async fn record(&self, key: &RecordKey) -> Result<Option<Record>> {
        self.storage.get_record(key).await
    }

    pub async fn pending_operations(&self, scope: impl Into<ScopeId>) -> Result<Vec<Operation>> {
        let stored = self
            .storage
            .list_operations(OperationFilter::pending_for_scope(scope))
            .await?;

        Ok(stored
            .into_iter()
            .map(|stored_operation| stored_operation.operation)
            .collect())
    }

    pub async fn apply_push_decision(&self, decision: PushDecision) -> Result<()> {
        match decision {
            PushDecision::Accepted {
                operation_id,
                remote_sequence,
            } => {
                self.storage
                    .mark_operation_status(
                        &operation_id,
                        OperationStatus::Accepted,
                        Some(remote_sequence),
                    )
                    .await
            }
            PushDecision::Rejected { operation_id, .. } => {
                self.storage
                    .mark_operation_status(&operation_id, OperationStatus::Rejected, None)
                    .await
            }
            PushDecision::Conflict {
                operation_id,
                conflict,
            } => {
                self.storage
                    .mark_operation_status(&operation_id, OperationStatus::Conflict, None)
                    .await?;
                self.storage.save_conflict(conflict).await
            }
            PushDecision::ServerPatch {
                operation_id,
                operation,
                remote_sequence,
                ..
            } => {
                self.storage
                    .mark_operation_status(
                        &operation_id,
                        OperationStatus::Accepted,
                        Some(remote_sequence),
                    )
                    .await?;
                self.apply_remote_operation(operation, remote_sequence)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn sync_once<E>(
        &self,
        scope: impl Into<ScopeId>,
        remote: impl Into<RemoteId>,
        endpoint: &E,
    ) -> Result<SyncSummary>
    where
        E: SyncEndpoint,
    {
        let scope = scope.into();
        let remote = remote.into();
        let cursor = self.storage.get_cursor(&scope, &remote).await?;
        let pending = self.pending_operations(scope.clone()).await?;
        let mut summary = SyncSummary::default();

        if !pending.is_empty() {
            let push_result = endpoint
                .push(PushRequest {
                    scope: scope.clone(),
                    operations: pending.clone(),
                    cursor: cursor.clone(),
                })
                .await?;

            validate_push_decisions(&pending, &push_result.decisions)?;

            summary.pushed = pending.len();

            let pending_by_id = pending
                .iter()
                .map(|operation| (&operation.id, &operation.key))
                .collect::<std::collections::HashMap<_, _>>();
            let non_applied_keys = push_result
                .decisions
                .iter()
                .filter_map(|decision| match decision {
                    PushDecision::Rejected { operation_id, .. }
                    | PushDecision::Conflict { operation_id, .. } => {
                        pending_by_id.get(operation_id).copied().cloned()
                    }
                    _ => None,
                })
                .collect::<HashSet<_>>();

            for decision in push_result.decisions {
                if matches!(decision, PushDecision::Conflict { .. }) {
                    summary.conflicts += 1;
                }
                self.apply_push_decision(decision).await?;
            }

            for key in non_applied_keys {
                self.reproject_non_rejected_operations(&key).await?;
            }

            for operation in push_result.server_operations {
                self.apply_to_projection(&operation).await?;
            }

            if let Some(cursor) = push_result.cursor {
                self.storage.save_cursor(cursor).await?;
            }
        }

        let cursor = self.storage.get_cursor(&scope, &remote).await?;
        let pull_result = endpoint
            .pull(PullRequest {
                scope: scope.clone(),
                cursor,
                limit: None,
            })
            .await?;

        summary.pulled = pull_result.operations.len();

        for pulled in pull_result.operations {
            self.apply_remote_operation(pulled.operation, pulled.remote_sequence)
                .await?;
        }

        if let Some(cursor) = pull_result.cursor {
            self.storage.save_cursor(cursor).await?;
        } else if summary.pulled == 0 {
            let cursor = SyncCursor::new(scope, remote, 0);
            self.storage.save_cursor(cursor).await?;
        }

        Ok(summary)
    }

    async fn apply_to_projection(&self, operation: &Operation) -> Result<Record> {
        let current = self.storage.get_record(&operation.key).await?;
        let projected = apply_operation(current, operation)?;
        self.storage.upsert_record(projected.clone()).await?;
        Ok(projected)
    }

    async fn reproject_non_rejected_operations(&self, key: &RecordKey) -> Result<()> {
        let mut operations = self
            .storage
            .list_operations(OperationFilter {
                scope: Some(key.scope.clone()),
                collection: Some(key.collection.clone()),
                ..OperationFilter::default()
            })
            .await?
            .into_iter()
            .filter(|stored| {
                stored.operation.key == *key
                    && matches!(
                        stored.status,
                        OperationStatus::Accepted | OperationStatus::Pending
                    )
            })
            .collect::<Vec<_>>();
        operations.sort_by_key(|stored| stored.local_sequence);

        let mut rebuilt = None;
        for stored in operations {
            rebuilt = Some(apply_operation(rebuilt, &stored.operation)?);
        }

        if let Some(record) = rebuilt {
            self.storage.upsert_record(record).await
        } else {
            self.storage.delete_record_projection(key).await
        }
    }
}

fn validate_push_decisions(pending: &[Operation], decisions: &[PushDecision]) -> Result<()> {
    let expected = pending
        .iter()
        .map(|operation| operation.id.clone())
        .collect::<HashSet<_>>();
    if expected.len() != pending.len() {
        return Err(crate::EngineError::SyncProtocol(
            "push request contains duplicate operation ids".to_owned(),
        ));
    }
    if decisions.len() != pending.len() {
        return Err(crate::EngineError::SyncProtocol(format!(
            "server returned {} decisions for {} operations",
            decisions.len(),
            pending.len()
        )));
    }

    let mut seen = HashSet::with_capacity(decisions.len());
    for decision in decisions {
        let operation_id = decision.operation_id();
        if !expected.contains(operation_id) {
            return Err(crate::EngineError::SyncProtocol(format!(
                "server returned a decision for unknown operation {operation_id}"
            )));
        }
        if !seen.insert(operation_id.clone()) {
            return Err(crate::EngineError::SyncProtocol(format!(
                "server returned duplicate decisions for operation {operation_id}"
            )));
        }
    }
    Ok(())
}

pub async fn mark_accepted<A>(
    storage: &A,
    operation_id: &OperationId,
    remote_sequence: i64,
) -> Result<()>
where
    A: StorageAdapter,
{
    storage
        .mark_operation_status(
            operation_id,
            OperationStatus::Accepted,
            Some(remote_sequence),
        )
        .await
}
