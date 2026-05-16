use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{
    types::{Conflict, Operation, OperationId, ScopeId, SyncCursor},
    Result,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PushRequest {
    pub scope: ScopeId,
    pub operations: Vec<Operation>,
    pub cursor: Option<SyncCursor>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PushResult {
    pub decisions: Vec<PushDecision>,
    pub server_operations: Vec<Operation>,
    pub cursor: Option<SyncCursor>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushDecision {
    Accepted {
        operation_id: OperationId,
        remote_sequence: i64,
    },
    Rejected {
        operation_id: OperationId,
        reason: String,
    },
    Conflict {
        operation_id: OperationId,
        conflict: Conflict,
    },
    ServerPatch {
        operation_id: OperationId,
        operation: Operation,
        remote_sequence: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PulledOperation {
    pub operation: Operation,
    pub remote_sequence: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PullRequest {
    pub scope: ScopeId,
    pub cursor: Option<SyncCursor>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PullResult {
    pub operations: Vec<PulledOperation>,
    pub cursor: Option<SyncCursor>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncSummary {
    pub pushed: usize,
    pub pulled: usize,
    pub conflicts: usize,
}

#[async_trait]
pub trait SyncEndpoint: Send + Sync {
    async fn push(&self, request: PushRequest) -> Result<PushResult>;

    async fn pull(&self, request: PullRequest) -> Result<PullResult>;
}
