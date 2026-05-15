//! Private offline sync core for Photon and Tachyon runtimes.
//!
//! The engine owns durable local persistence, append-only operations,
//! materialized projections, cursor checkpoints, and deterministic conflict
//! policy. Realtime transports such as WebSocket, Durable Objects, and Yjs
//! awareness stay outside this crate.

pub mod engine;
pub mod error;
#[cfg(feature = "memory")]
pub mod memory;
pub mod projection;
pub mod protocol;
#[cfg(feature = "sqlite")]
pub mod sqlite;
pub mod storage;
pub mod types;

pub use engine::PhotonEngine;
pub use error::{EngineError, Result};
#[cfg(feature = "memory")]
pub use memory::MemoryAdapter;
pub use protocol::{
    PullRequest, PullResult, PulledOperation, PushDecision, PushRequest, PushResult, SyncEndpoint,
    SyncSummary,
};
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteAdapter;
pub use storage::StorageAdapter;
pub use types::{
    ActorId, CollectionName, Conflict, ConflictId, HybridTimestamp, Operation, OperationFilter,
    OperationId, OperationKind, OperationStatus, Record, RecordId, RecordKey, RemoteId, ScopeId,
    StoredOperation, SyncCursor,
};
