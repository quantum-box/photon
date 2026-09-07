//! Domain-level authorization: the hook between "this token may write to this
//! tenant" and "this *caller* may make this *specific* change".
//!
//! The bearer-token boundary in [`crate::auth`] answers the service question.
//! What it cannot answer is the product question — may this user move an
//! issue to `done`, may anyone write to `audit_events` at all — because the
//! answer lives in the host application's domain model, not in Photon.
//!
//! So the server evaluates every pushed operation against an [`EnginePolicy`]
//! before applying it. The default policy allows everything the token grant
//! already allowed, which keeps local development and single-tenant
//! deployments zero-config. A host embeds its own rules by constructing
//! [`crate::AppState`] with its own implementation; a rejection becomes a
//! per-operation `PushDecision::Rejected`, which the client engine rolls back
//! by replay — exactly the same path a validation failure takes.

use async_trait::async_trait;
use photon_engine::Operation;

use crate::auth::{TokenGrant, WorkspaceScope};

/// Everything the server knows about a pushed operation at decision time.
pub struct OperationContext<'a> {
    /// The grant carried by the caller's bearer token.
    pub grant: &'a TokenGrant,
    /// The parsed, already tenant-checked request scope.
    pub workspace: &'a WorkspaceScope,
    pub operation: &'a Operation,
}

pub enum PolicyVerdict {
    Allow,
    /// Becomes a `PushDecision::Rejected` for this one operation. The reason
    /// travels back to the client and surfaces in `useMutation.error`.
    Reject {
        reason: String,
    },
}

/// Host-supplied write authorization, consulted once per pushed operation.
#[async_trait]
pub trait EnginePolicy: Send + Sync {
    /// Host-supplied read rule for scoped snapshots and deltas. Authorization
    /// rules live outside the engine. Hosts must also emit a change/invalidation
    /// when permissions change without a record mutation.
    async fn authorize_read(
        &self,
        _grant: &TokenGrant,
        _workspace: &WorkspaceScope,
        _record: &photon_engine::Record,
    ) -> bool {
        true
    }

    async fn authorize_operation(&self, ctx: OperationContext<'_>) -> PolicyVerdict;
}

/// The default policy: the token grant is the whole policy.
pub struct AllowAllPolicy;

#[async_trait]
impl EnginePolicy for AllowAllPolicy {
    async fn authorize_operation(&self, _ctx: OperationContext<'_>) -> PolicyVerdict {
        PolicyVerdict::Allow
    }
}
