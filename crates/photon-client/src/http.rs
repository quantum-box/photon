//! HTTP transport for [`SyncEndpoint`], behind the `http` feature.
//!
//! Kept out of the core module so hosts that bring their own transport —
//! in-process routers in tests, Tauri IPC, a tunnel — never compile reqwest.

use async_trait::async_trait;
use photon_engine::{
    EngineError, PullRequest, PullResult, PushRequest, PushResult, Result, SyncEndpoint,
};

/// Talks to `photon_axum`'s engine routes: `POST {base}/api/engine/push` and
/// `POST {base}/api/engine/pull`.
pub struct HttpSyncEndpoint {
    base_url: String,
    client: reqwest::Client,
}

impl HttpSyncEndpoint {
    /// `base_url` is the server origin, e.g. `http://127.0.0.1:3001`.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self::with_client(base_url, reqwest::Client::new())
    }

    /// Bring a preconfigured reqwest client (proxies, headers, timeouts).
    pub fn with_client(base_url: impl Into<String>, client: reqwest::Client) -> Self {
        let mut base_url = base_url.into();
        while base_url.ends_with('/') {
            base_url.pop();
        }
        Self { base_url, client }
    }

    async fn post_json<Req, Res>(&self, path: &str, request: &Req) -> Result<Res>
    where
        Req: serde::Serialize,
        Res: serde::de::DeserializeOwned,
    {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .client
            .post(&url)
            .json(request)
            .send()
            .await
            .map_err(|error| EngineError::Storage(format!("http request failed: {error}")))?;

        let status = response.status();
        if !status.is_success() {
            return Err(EngineError::Storage(format!(
                "http {path} returned status {status}"
            )));
        }

        response
            .json::<Res>()
            .await
            .map_err(|error| EngineError::Storage(format!("http response decode failed: {error}")))
    }
}

#[async_trait]
impl SyncEndpoint for HttpSyncEndpoint {
    async fn push(&self, request: PushRequest) -> Result<PushResult> {
        self.post_json("/api/engine/push", &request).await
    }

    async fn pull(&self, request: PullRequest) -> Result<PullResult> {
        self.post_json("/api/engine/pull", &request).await
    }
}
