//! End-to-end client/server convergence, entirely in-process.
//!
//! Spins up `photon_axum::engine_router()` and drives it through
//! `tower::ServiceExt::oneshot`, so this covers the same push/pull HTTP
//! contract production uses without binding a socket.

use async_trait::async_trait;
use axum::{body::Body, http::Request, Router};
use photon_client::{
    EngineError, PhotonClient, PullRequest, PullResult, PushRequest, PushResult, Result,
    SyncEndpoint,
};
use tower::ServiceExt;

const SCOPE: &str = "tenant:photon:workspace:photon-default";

/// A [`SyncEndpoint`] that drives an axum router in-process.
struct RouterEndpoint {
    router: Router,
}

impl RouterEndpoint {
    async fn post_json<Req, Res>(&self, path: &str, request: &Req) -> Result<Res>
    where
        Req: serde::Serialize,
        Res: serde::de::DeserializeOwned,
    {
        let body = serde_json::to_vec(request)?;
        let response = self
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request builds"),
            )
            .await
            .map_err(|error| EngineError::Storage(format!("router call failed: {error}")))?;

        let status = response.status();
        if !status.is_success() {
            return Err(EngineError::Storage(format!(
                "router {path} returned status {status}"
            )));
        }

        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .map_err(|error| EngineError::Storage(format!("router body read failed: {error}")))?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

#[async_trait]
impl SyncEndpoint for RouterEndpoint {
    async fn push(&self, request: PushRequest) -> Result<PushResult> {
        self.post_json("/api/engine/push", &request).await
    }

    async fn pull(&self, request: PullRequest) -> Result<PullResult> {
        self.post_json("/api/engine/pull", &request).await
    }
}

async fn server_endpoint() -> RouterEndpoint {
    let state = photon_axum::build_state("sqlite::memory:", "sqlite::memory:")
        .await
        .expect("server state builds");
    RouterEndpoint {
        router: photon_axum::engine_router(state),
    }
}

fn client(actor: &str) -> PhotonClient {
    PhotonClient::builder()
        .actor_id(actor)
        .scope(SCOPE)
        .build()
        .expect("client builds")
}

#[tokio::test]
async fn offline_write_push_pull_converges() {
    let endpoint = server_endpoint().await;
    let writer = client("client-writer");
    let reader = client("client-reader");

    // Offline: the write lands locally and stays pending.
    writer
        .upsert(
            "issues",
            "issue-e2e-1",
            serde_json::json!({ "id": "issue-e2e-1", "title": "Converge me", "status": "open" }),
        )
        .await
        .unwrap();
    assert_eq!(writer.pending_operations().await.unwrap().len(), 1);

    // Push: the server accepts and the operation stops being pending.
    let summary = writer.sync_once(&endpoint).await.unwrap();
    assert_eq!(summary.pushed, 1);
    assert_eq!(summary.conflicts, 0);
    assert!(writer.pending_operations().await.unwrap().is_empty());

    // Pull from a second client: same record, same value.
    let summary = reader.sync_once(&endpoint).await.unwrap();
    assert!(summary.pulled >= 1);

    let written = writer
        .record("issues", "issue-e2e-1")
        .await
        .unwrap()
        .unwrap();
    let read = reader
        .record("issues", "issue-e2e-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.value, written.value);
    assert_eq!(read.value["title"], "Converge me");
}

#[tokio::test]
async fn second_sync_is_idempotent_and_patches_merge() {
    let endpoint = server_endpoint().await;
    let writer = client("client-writer");
    let reader = client("client-reader");

    writer
        .upsert(
            "issues",
            "issue-e2e-2",
            serde_json::json!({ "id": "issue-e2e-2", "title": "First", "status": "open" }),
        )
        .await
        .unwrap();
    writer.sync_once(&endpoint).await.unwrap();
    reader.sync_once(&endpoint).await.unwrap();

    // A follow-up patch from the reader flows back to the writer.
    reader
        .patch(
            "issues",
            "issue-e2e-2",
            [("status".to_owned(), serde_json::json!("done"))],
        )
        .await
        .unwrap();
    reader.sync_once(&endpoint).await.unwrap();
    writer.sync_once(&endpoint).await.unwrap();

    let record = writer
        .record("issues", "issue-e2e-2")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.value["title"], "First");
    assert_eq!(record.value["status"], "done");

    // Cursors advanced: another sync moves nothing.
    let summary = writer.sync_once(&endpoint).await.unwrap();
    assert_eq!(summary.pushed, 0);
    assert_eq!(summary.pulled, 0);
}

#[tokio::test]
async fn delete_propagates_between_clients() {
    let endpoint = server_endpoint().await;
    let writer = client("client-writer");
    let reader = client("client-reader");

    writer
        .upsert(
            "issues",
            "issue-e2e-3",
            serde_json::json!({ "id": "issue-e2e-3", "title": "Doomed" }),
        )
        .await
        .unwrap();
    writer.sync_once(&endpoint).await.unwrap();
    reader.sync_once(&endpoint).await.unwrap();

    writer.delete("issues", "issue-e2e-3").await.unwrap();
    writer.sync_once(&endpoint).await.unwrap();
    reader.sync_once(&endpoint).await.unwrap();

    let record = reader
        .record("issues", "issue-e2e-3")
        .await
        .unwrap()
        .unwrap();
    assert!(record.is_deleted());
}
