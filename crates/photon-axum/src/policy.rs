//! Domain-level authorization: the hook between "this token may write to this
//! tenant" and "this *caller* may make this *specific* change".
//!
//! The bearer-token boundary in [`crate::auth`] answers the service question.
//! What it cannot answer is the product question — may this user move an
//! issue to `done`, may anyone write to `audit_events` at all — because the
//! answer lives in the host application's domain model, not in Photon.
//!
//! So the server evaluates every pushed batch against an [`EnginePolicy`]
//! before applying it. The default implementation delegates to the per-item
//! hook, while a remote policy can override the batch hook to avoid N+1 calls.
//! The default policy allows everything the token grant
//! already allowed, which keeps local development and single-tenant
//! deployments zero-config. A host embeds its own rules by constructing
//! [`crate::AppState`] with its own implementation; a rejection becomes a
//! per-operation `PushDecision::Rejected`, which the client engine rolls back
//! by replay — exactly the same path a validation failure takes.

use async_trait::async_trait;
use photon_engine::{Operation, OperationId};

use crate::auth::{TokenGrant, WorkspaceScope};

/// Infrastructure failures are not authorization denials. A caller must keep
/// its operations pending and retry instead of rolling them back permanently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError {
    message: String,
}

impl PolicyError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub(crate) fn invalid_response(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PolicyError {}

/// Everything the server knows about a pushed operation at decision time.
pub struct OperationContext<'a> {
    /// The grant carried by the caller's bearer token.
    pub grant: &'a TokenGrant,
    /// The parsed, already tenant-checked request scope.
    pub workspace: &'a WorkspaceScope,
    pub operation: &'a Operation,
}

/// One push worth of operations. Remote policies override the batch method so
/// authorization costs one upstream lookup rather than one lookup per item.
pub struct PushContext<'a> {
    pub grant: &'a TokenGrant,
    pub workspace: &'a WorkspaceScope,
    pub operations: &'a [Operation],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyVerdict {
    Allow,
    /// Becomes a `PushDecision::Rejected` for this one operation. The reason
    /// travels back to the client and surfaces in `useMutation.error`.
    Reject {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyDecision {
    pub operation_id: OperationId,
    pub verdict: PolicyVerdict,
}

impl PolicyDecision {
    pub fn new(operation_id: OperationId, verdict: PolicyVerdict) -> Self {
        Self {
            operation_id,
            verdict,
        }
    }
}

/// Host-supplied write authorization. Infrastructure errors fail the complete
/// push with 503; they never become permanent per-operation rejections.
#[async_trait]
pub trait EnginePolicy: Send + Sync {
    async fn authorize_operations(
        &self,
        ctx: PushContext<'_>,
    ) -> Result<Vec<PolicyDecision>, PolicyError> {
        let mut decisions = Vec::with_capacity(ctx.operations.len());
        for operation in ctx.operations {
            decisions.push(PolicyDecision::new(
                operation.id.clone(),
                self.authorize_operation(OperationContext {
                    grant: ctx.grant,
                    workspace: ctx.workspace,
                    operation,
                })
                .await?,
            ));
        }
        Ok(decisions)
    }

    async fn authorize_operation(
        &self,
        ctx: OperationContext<'_>,
    ) -> Result<PolicyVerdict, PolicyError>;
}

/// The default policy: the token grant is the whole policy.
pub struct AllowAllPolicy;

#[async_trait]
impl EnginePolicy for AllowAllPolicy {
    async fn authorize_operation(
        &self,
        _ctx: OperationContext<'_>,
    ) -> Result<PolicyVerdict, PolicyError> {
        Ok(PolicyVerdict::Allow)
    }
}
