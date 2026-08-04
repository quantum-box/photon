//! The authorization boundary for Engine push/pull and Live rooms.
//!
//! Photon sits behind an application edge (the Cloudflare Worker, or an
//! application server) that authenticates end users. What this module enforces
//! is the *service* boundary: nothing reaches the operation log or a Live room
//! without presenting a bearer token this process was configured to trust, and
//! a token can be confined to a single tenant so a compromised edge deployment
//! cannot write into another tenant's workspace.
//!
//! Configuration is one environment variable:
//!
//! ```text
//! PHOTON_AUTH_TOKENS=<entry>[,<entry>...]
//! entry = <token>            # trusted for every tenant
//!       | <token>@<tenant>   # trusted for exactly one tenant
//! ```
//!
//! An empty or unset variable disables authentication. That is the local
//! development mode; `build_state` logs a warning so it cannot happen silently
//! in a deployment.

use std::collections::HashMap;

use photon_engine::ScopeId;

/// What a validated bearer token is allowed to touch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenGrant {
    AllTenants,
    Tenant(String),
}

impl TokenGrant {
    pub fn allows_tenant(&self, tenant_id: &str) -> bool {
        match self {
            Self::AllTenants => true,
            Self::Tenant(granted) => granted == tenant_id,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// No `Authorization: Bearer` (or `?token=`) was presented.
    MissingToken,
    /// A token was presented but is not one this process trusts.
    InvalidToken,
}

/// The set of bearer tokens this process trusts.
#[derive(Clone, Debug, Default)]
pub struct AuthConfig {
    tokens: HashMap<String, TokenGrant>,
}

impl AuthConfig {
    /// No tokens, every caller is granted everything. Local development only.
    pub fn disabled() -> Self {
        Self::default()
    }

    /// Parse the `PHOTON_AUTH_TOKENS` entry format.
    pub fn from_spec(spec: &str) -> Result<Self, String> {
        let mut tokens = HashMap::new();
        for entry in spec.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let (token, grant) = match entry.split_once('@') {
                Some((token, tenant)) => {
                    let token = token.trim();
                    let tenant = tenant.trim();
                    if tenant.is_empty() {
                        return Err(format!(
                            "PHOTON_AUTH_TOKENS entry has an empty tenant: {entry:?}"
                        ));
                    }
                    (token, TokenGrant::Tenant(tenant.to_owned()))
                }
                None => (entry, TokenGrant::AllTenants),
            };
            if token.is_empty() {
                return Err(format!(
                    "PHOTON_AUTH_TOKENS entry has an empty token: {entry:?}"
                ));
            }
            tokens.insert(token.to_owned(), grant);
        }
        Ok(Self { tokens })
    }

    /// Read `PHOTON_AUTH_TOKENS`. A malformed value is a configuration error
    /// and must stop the process rather than silently run open.
    pub fn from_env() -> Result<Self, String> {
        match std::env::var("PHOTON_AUTH_TOKENS") {
            Ok(spec) => Self::from_spec(&spec),
            Err(_) => Ok(Self::disabled()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.tokens.is_empty()
    }

    pub fn authorize(&self, bearer: Option<&str>) -> Result<TokenGrant, AuthError> {
        if !self.is_enabled() {
            return Ok(TokenGrant::AllTenants);
        }
        let token = bearer.ok_or(AuthError::MissingToken)?;
        self.tokens
            .get(token)
            .cloned()
            .ok_or(AuthError::InvalidToken)
    }
}

/// The one scope shape the server accepts on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceScope {
    pub tenant_id: String,
    pub workspace_id: String,
}

/// Parse `tenant:{tenant}:workspace:{workspace}` strictly.
///
/// The scope is opaque to the engine core, but the server must be able to say
/// *which tenant* an operation belongs to before it can authorize it, so the
/// HTTP boundary pins the format. Anything else is rejected rather than
/// guessed at.
pub fn parse_workspace_scope(scope: &ScopeId) -> Option<WorkspaceScope> {
    let text = scope.to_string();
    let mut parts = text.splitn(4, ':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("tenant"), Some(tenant), Some("workspace"), Some(workspace))
            if !tenant.is_empty() && !workspace.is_empty() && !workspace.contains(':') =>
        {
            Some(WorkspaceScope {
                tenant_id: tenant.to_owned(),
                workspace_id: workspace.to_owned(),
            })
        }
        _ => None,
    }
}

/// Extract the bearer token from an `Authorization` header, if any.
pub fn bearer_token(headers: &axum::http::HeaderMap) -> Option<&str> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spec_parses_global_and_tenant_scoped_tokens() {
        let config = AuthConfig::from_spec(" edge-token , acme-token@acme ").unwrap();
        assert!(config.is_enabled());
        assert_eq!(
            config.authorize(Some("edge-token")),
            Ok(TokenGrant::AllTenants)
        );
        assert_eq!(
            config.authorize(Some("acme-token")),
            Ok(TokenGrant::Tenant("acme".into()))
        );
        assert_eq!(
            config.authorize(Some("unknown")),
            Err(AuthError::InvalidToken)
        );
        assert_eq!(config.authorize(None), Err(AuthError::MissingToken));
    }

    #[test]
    fn test_spec_rejects_empty_token_or_tenant() {
        assert!(AuthConfig::from_spec("@acme").is_err());
        assert!(AuthConfig::from_spec("token@").is_err());
    }

    #[test]
    fn test_empty_spec_disables_auth() {
        let config = AuthConfig::from_spec("  ").unwrap();
        assert!(!config.is_enabled());
        assert_eq!(config.authorize(None), Ok(TokenGrant::AllTenants));
    }

    #[test]
    fn test_tenant_grant_confines_to_one_tenant() {
        let grant = TokenGrant::Tenant("acme".into());
        assert!(grant.allows_tenant("acme"));
        assert!(!grant.allows_tenant("globex"));
        assert!(TokenGrant::AllTenants.allows_tenant("anyone"));
    }

    #[test]
    fn test_workspace_scope_parses_strictly() {
        let parsed = parse_workspace_scope(&ScopeId::from("tenant:acme:workspace:roadmap"));
        assert_eq!(
            parsed,
            Some(WorkspaceScope {
                tenant_id: "acme".into(),
                workspace_id: "roadmap".into(),
            })
        );

        for malformed in [
            "workspace:acme:roadmap",
            "tenant:acme",
            "tenant::workspace:roadmap",
            "tenant:acme:workspace:",
            "tenant:acme:workspace:roadmap:extra",
            "",
        ] {
            assert_eq!(
                parse_workspace_scope(&ScopeId::from(malformed)),
                None,
                "scope {malformed:?} must be rejected"
            );
        }
    }

    #[test]
    fn test_bearer_token_extraction() {
        let mut headers = axum::http::HeaderMap::new();
        assert_eq!(bearer_token(&headers), None);

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer secret-token".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers), Some("secret-token"));

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Basic dXNlcjpwYXNz".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers), None);
    }
}
