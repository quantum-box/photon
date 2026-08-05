use photon_engine::Operation;
use serde::{Deserialize, Serialize};

use crate::auth::{TokenGrant, WorkspaceScope};

pub const AUDIT_METADATA_KEY: &str = "photon_audit";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditPrincipalType {
    Service,
    User,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditServiceGrant {
    AllTenants,
    Tenant,
}

/// Server-owned audit data attached to every accepted operation.
///
/// User identity fields are optional until the principal-aware authenticator
/// is wired in. They must only ever be populated from a verified principal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhotonAuditStamp {
    pub principal_type: AuditPrincipalType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_behalf_of_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_grant: Option<AuditServiceGrant>,
    pub tenant_id: String,
    pub workspace_id: String,
    pub request_id: String,
    pub received_at_ms: i64,
}

impl PhotonAuditStamp {
    pub(crate) fn for_service(
        grant: &TokenGrant,
        workspace: &WorkspaceScope,
        request_id: impl Into<String>,
        received_at_ms: i64,
    ) -> Self {
        Self {
            principal_type: AuditPrincipalType::Service,
            principal_id: None,
            on_behalf_of_user_id: None,
            service_grant: Some(match grant {
                TokenGrant::AllTenants => AuditServiceGrant::AllTenants,
                TokenGrant::Tenant(_) => AuditServiceGrant::Tenant,
            }),
            tenant_id: workspace.tenant_id.clone(),
            workspace_id: workspace.workspace_id.clone(),
            request_id: request_id.into(),
            received_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditMetadataError {
    operation_id: String,
}

impl std::fmt::Display for AuditMetadataError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "operation {} metadata must be an object or null",
            self.operation_id
        )
    }
}

impl std::error::Error for AuditMetadataError {}

pub(crate) fn validate_audit_metadata(operation: &Operation) -> Result<(), AuditMetadataError> {
    if operation.metadata.is_null() || operation.metadata.is_object() {
        return Ok(());
    }
    Err(AuditMetadataError {
        operation_id: operation.id.to_string(),
    })
}

pub(crate) fn stamp_audit_metadata(
    operation: &mut Operation,
    stamp: &PhotonAuditStamp,
) -> Result<(), AuditMetadataError> {
    validate_audit_metadata(operation)?;
    if operation.metadata.is_null() {
        operation.metadata = serde_json::Value::Object(serde_json::Map::new());
    }
    let metadata = operation
        .metadata
        .as_object_mut()
        .ok_or_else(|| AuditMetadataError {
            operation_id: operation.id.to_string(),
        })?;
    metadata.insert(
        AUDIT_METADATA_KEY.to_owned(),
        serde_json::to_value(stamp).map_err(|_| AuditMetadataError {
            operation_id: operation.id.to_string(),
        })?,
    );
    Ok(())
}
