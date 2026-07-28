//! Photon Rust client SDK.
//!
//! [`PhotonClient`] gives a native host the same contract the TypeScript
//! client has: write offline against local storage, then reconcile with a
//! server through [`SyncEndpoint`] when the network allows it.
//!
//! Operation construction mirrors the WASM kernel
//! (`photon_engine::wasm::PhotonKernel::build_operation`) exactly: the hybrid
//! clock ticks before every operation and the caller supplies the wall clock,
//! so the same intent produces the same bytes in both runtimes.
//!
//! Transport stays out of the core: this crate depends only on the
//! [`SyncEndpoint`] trait. The batteries-included HTTP transport is
//! [`HttpSyncEndpoint`] behind the `http` feature.

use std::sync::Mutex;

use photon_engine::types::unix_time_ms;
use photon_engine::Record;
pub use photon_engine::{
    ActorId, CollectionName, EngineError, HybridTimestamp, MemoryAdapter, Operation, OperationKind,
    PhotonEngine, PullRequest, PullResult, PushRequest, PushResult, RecordId, RecordKey, RemoteId,
    Result, ScopeId, StorageAdapter, SyncEndpoint, SyncSummary,
};

#[cfg(feature = "http")]
mod http;
#[cfg(feature = "http")]
pub use http::HttpSyncEndpoint;

/// Wall clock used by the client. Injectable so tests are reproducible.
pub type Clock = fn() -> i64;

const DEFAULT_REMOTE_ID: &str = "photon-server";

/// Builder for [`PhotonClient`].
pub struct PhotonClientBuilder<A = MemoryAdapter> {
    actor_id: Option<ActorId>,
    scope: Option<ScopeId>,
    remote: RemoteId,
    storage: A,
    clock: Clock,
}

impl PhotonClientBuilder<MemoryAdapter> {
    fn new() -> Self {
        Self {
            actor_id: None,
            scope: None,
            remote: RemoteId::from(DEFAULT_REMOTE_ID),
            storage: MemoryAdapter::new(),
            clock: unix_time_ms,
        }
    }
}

impl<A> PhotonClientBuilder<A> {
    /// Identifies this client in operations and hybrid timestamps. Required.
    pub fn actor_id(mut self, actor_id: impl Into<ActorId>) -> Self {
        self.actor_id = Some(actor_id.into());
        self
    }

    /// The sync scope every operation belongs to. Required.
    pub fn scope(mut self, scope: impl Into<ScopeId>) -> Self {
        self.scope = Some(scope.into());
        self
    }

    /// Cursor namespace for the remote. Defaults to `photon-server`.
    pub fn remote(mut self, remote: impl Into<RemoteId>) -> Self {
        self.remote = remote.into();
        self
    }

    /// Replace the storage adapter. Defaults to [`MemoryAdapter`]; a Tauri
    /// host will hand in its native SQLite-backed adapter here.
    pub fn storage<B: StorageAdapter>(self, storage: B) -> PhotonClientBuilder<B> {
        PhotonClientBuilder {
            actor_id: self.actor_id,
            scope: self.scope,
            remote: self.remote,
            storage,
            clock: self.clock,
        }
    }

    /// Override the wall clock, for deterministic tests.
    pub fn clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    pub fn build(self) -> Result<PhotonClient<A>>
    where
        A: StorageAdapter,
    {
        let actor_id = self
            .actor_id
            .ok_or_else(|| EngineError::Storage("PhotonClient requires an actor_id".into()))?;
        let scope = self
            .scope
            .ok_or_else(|| EngineError::Storage("PhotonClient requires a scope".into()))?;
        let now_ms = (self.clock)();

        Ok(PhotonClient {
            engine: PhotonEngine::new(self.storage),
            hybrid_clock: Mutex::new(HybridTimestamp::at(now_ms, actor_id.clone())),
            actor_id,
            scope,
            remote: self.remote,
            clock: self.clock,
        })
    }
}

/// Offline-first Photon Engine client for native Rust hosts.
pub struct PhotonClient<A = MemoryAdapter> {
    engine: PhotonEngine<A>,
    actor_id: ActorId,
    scope: ScopeId,
    remote: RemoteId,
    clock: Clock,
    hybrid_clock: Mutex<HybridTimestamp>,
}

impl PhotonClient<MemoryAdapter> {
    pub fn builder() -> PhotonClientBuilder<MemoryAdapter> {
        PhotonClientBuilder::new()
    }
}

impl<A> PhotonClient<A> {
    pub fn actor_id(&self) -> &ActorId {
        &self.actor_id
    }

    pub fn scope(&self) -> &ScopeId {
        &self.scope
    }

    /// Turn an intent into a fully-formed operation, advancing the hybrid
    /// clock. Semantics match the WASM kernel's `buildOperation` — same
    /// intent, same actor, same clock readings, same bytes.
    pub fn build_operation(
        &self,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
        kind: OperationKind,
    ) -> Operation {
        let now_ms = (self.clock)();
        let timestamp = {
            let mut clock = self.hybrid_clock.lock().expect("hybrid clock poisoned");
            *clock = clock.tick_at(now_ms, self.actor_id.clone());
            clock.clone()
        };

        Operation::at(
            now_ms,
            RecordKey::new(self.scope.clone(), collection, record_id),
            self.actor_id.clone(),
            kind,
        )
        .with_timestamp(timestamp)
    }
}

impl<A> PhotonClient<A>
where
    A: StorageAdapter,
{
    /// Apply a mutation locally. Works offline: the operation is appended to
    /// the local op-log as pending and projected immediately; the next
    /// [`sync_once`](Self::sync_once) pushes it.
    pub async fn apply(
        &self,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
        kind: OperationKind,
    ) -> Result<Record> {
        let operation = self.build_operation(collection, record_id, kind);
        self.engine.apply_local_operation(operation).await
    }

    /// Create or replace a record.
    pub async fn upsert(
        &self,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
        value: serde_json::Value,
    ) -> Result<Record> {
        self.apply(collection, record_id, OperationKind::Upsert { value })
            .await
    }

    /// Merge fields into a record.
    pub async fn patch(
        &self,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
        fields: impl IntoIterator<Item = (String, serde_json::Value)>,
    ) -> Result<Record> {
        self.apply(
            collection,
            record_id,
            OperationKind::Patch {
                fields: fields.into_iter().collect(),
            },
        )
        .await
    }

    /// Soft-delete a record.
    pub async fn delete(
        &self,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
    ) -> Result<Record> {
        self.apply(collection, record_id, OperationKind::Delete)
            .await
    }

    /// Current projection of one record, or `None` if it never existed.
    pub async fn record(
        &self,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
    ) -> Result<Option<Record>> {
        self.engine
            .record(&RecordKey::new(self.scope.clone(), collection, record_id))
            .await
    }

    /// Operations written locally but not yet accepted by the server.
    pub async fn pending_operations(&self) -> Result<Vec<Operation>> {
        self.engine.pending_operations(self.scope.clone()).await
    }

    /// One push/pull cycle against the endpoint: push pending operations,
    /// apply the server's decisions, then pull and project remote operations.
    pub async fn sync_once<E>(&self, endpoint: &E) -> Result<SyncSummary>
    where
        E: SyncEndpoint,
    {
        self.engine
            .sync_once(self.scope.clone(), self.remote.clone(), endpoint)
            .await
    }

    /// Direct access to the underlying engine for advanced hosts.
    pub fn engine(&self) -> &PhotonEngine<A> {
        &self.engine
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_clock() -> i64 {
        1_700_000_000_500
    }

    #[tokio::test]
    async fn offline_writes_are_pending_until_synced() {
        let client = PhotonClient::builder()
            .actor_id("actor-test")
            .scope("tenant:acme:workspace:demo")
            .clock(fixed_clock)
            .build()
            .unwrap();

        client
            .upsert(
                "issues",
                "issue-1",
                serde_json::json!({ "title": "Offline" }),
            )
            .await
            .unwrap();

        let pending = client.pending_operations().await.unwrap();
        assert_eq!(pending.len(), 1);
        let record = client.record("issues", "issue-1").await.unwrap().unwrap();
        assert_eq!(record.value["title"], "Offline");
    }

    #[test]
    fn build_operation_ticks_the_hybrid_clock() {
        let client = PhotonClient::builder()
            .actor_id("actor-test")
            .scope("tenant:acme:workspace:demo")
            .clock(fixed_clock)
            .build()
            .unwrap();

        let first = client.build_operation("issues", "a", OperationKind::Delete);
        let second = client.build_operation("issues", "b", OperationKind::Delete);
        // Same wall clock, so causality is carried by the counter.
        assert_eq!(first.timestamp.wall_time_ms, second.timestamp.wall_time_ms);
        assert!(second.timestamp.counter > first.timestamp.counter);
    }

    #[test]
    fn builder_requires_actor_and_scope() {
        assert!(PhotonClient::builder().scope("s").build().is_err());
        assert!(PhotonClient::builder().actor_id("a").build().is_err());
    }
}
