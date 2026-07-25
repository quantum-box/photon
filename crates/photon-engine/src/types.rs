#[cfg(not(target_arch = "wasm32"))]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

string_id!(ScopeId);
string_id!(CollectionName);
string_id!(RecordId);
string_id!(ActorId);
string_id!(OperationId);
string_id!(RemoteId);
string_id!(ConflictId);
string_id!(SnapshotFormat);

impl OperationId {
    pub fn random() -> Self {
        Self(format!("op_{}", Uuid::new_v4()))
    }
}

impl ConflictId {
    pub fn random() -> Self {
        Self(format!("conflict_{}", Uuid::new_v4()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct HybridTimestamp {
    pub wall_time_ms: i64,
    pub counter: u32,
    pub actor_id: ActorId,
}

impl HybridTimestamp {
    pub fn new(wall_time_ms: i64, counter: u32, actor_id: impl Into<ActorId>) -> Self {
        Self {
            wall_time_ms,
            counter,
            actor_id: actor_id.into(),
        }
    }

    pub fn now(actor_id: impl Into<ActorId>) -> Self {
        Self::at(unix_time_ms(), actor_id)
    }

    /// [`HybridTimestamp::now`] with the clock supplied by the caller.
    pub fn at(now_ms: i64, actor_id: impl Into<ActorId>) -> Self {
        Self {
            wall_time_ms: now_ms,
            counter: 0,
            actor_id: actor_id.into(),
        }
    }

    pub fn tick(&self, actor_id: impl Into<ActorId>) -> Self {
        self.tick_at(unix_time_ms(), actor_id)
    }

    /// [`HybridTimestamp::tick`] with the clock supplied by the caller.
    pub fn tick_at(&self, now_ms: i64, actor_id: impl Into<ActorId>) -> Self {
        let actor_id = actor_id.into();
        if now_ms > self.wall_time_ms {
            Self::new(now_ms, 0, actor_id)
        } else {
            Self::new(self.wall_time_ms, self.counter + 1, actor_id)
        }
    }

    /// Advance past a timestamp observed from another actor.
    ///
    /// This is what keeps causality intact when a remote operation arrives with
    /// a clock ahead of ours.
    pub fn observe(&self, other: &Self, now_ms: i64, actor_id: impl Into<ActorId>) -> Self {
        let ceiling = now_ms.max(other.wall_time_ms).max(self.wall_time_ms);
        let actor_id = actor_id.into();
        if ceiling > self.wall_time_ms && ceiling > other.wall_time_ms {
            Self::new(ceiling, 0, actor_id)
        } else {
            Self::new(ceiling, self.counter.max(other.counter) + 1, actor_id)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RecordKey {
    pub scope: ScopeId,
    pub collection: CollectionName,
    pub record_id: RecordId,
}

impl RecordKey {
    pub fn new(
        scope: impl Into<ScopeId>,
        collection: impl Into<CollectionName>,
        record_id: impl Into<RecordId>,
    ) -> Self {
        Self {
            scope: scope.into(),
            collection: collection.into(),
            record_id: record_id.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OperationKind {
    Upsert { value: Value },
    Patch { fields: BTreeMap<String, Value> },
    RemoveFields { fields: Vec<String> },
    Delete,
    Restore { value: Option<Value> },
    Increment { field: String, by: i64 },
    SetAdd { field: String, values: Vec<Value> },
    SetRemove { field: String, values: Vec<Value> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Operation {
    pub id: OperationId,
    pub key: RecordKey,
    pub actor_id: ActorId,
    pub timestamp: HybridTimestamp,
    pub kind: OperationKind,
    #[serde(default)]
    pub metadata: Value,
}

impl Operation {
    pub fn new(key: RecordKey, actor_id: impl Into<ActorId>, kind: OperationKind) -> Self {
        Self::at(unix_time_ms(), key, actor_id, kind)
    }

    /// [`Operation::new`] with the clock supplied by the caller.
    pub fn at(
        now_ms: i64,
        key: RecordKey,
        actor_id: impl Into<ActorId>,
        kind: OperationKind,
    ) -> Self {
        let actor_id = actor_id.into();
        Self {
            id: OperationId::random(),
            key,
            timestamp: HybridTimestamp::at(now_ms, actor_id.clone()),
            actor_id,
            kind,
            metadata: Value::Null,
        }
    }

    pub fn with_id(mut self, id: impl Into<OperationId>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_timestamp(mut self, timestamp: HybridTimestamp) -> Self {
        self.timestamp = timestamp;
        self
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Pending,
    Accepted,
    Rejected,
    Conflict,
}

impl OperationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Conflict => "conflict",
        }
    }

    pub fn parse(value: &str) -> crate::Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "rejected" => Ok(Self::Rejected),
            "conflict" => Ok(Self::Conflict),
            other => Err(crate::EngineError::InvalidOperationStatus(other.to_owned())),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredOperation {
    pub operation: Operation,
    pub status: OperationStatus,
    pub local_sequence: i64,
    pub remote_sequence: Option<i64>,
    pub received_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub key: RecordKey,
    pub value: Value,
    pub version: HybridTimestamp,
    pub field_versions: BTreeMap<String, HybridTimestamp>,
    pub deleted_at: Option<HybridTimestamp>,
    pub updated_by: ActorId,
}

impl Record {
    pub fn new(
        key: RecordKey,
        value: Value,
        version: HybridTimestamp,
        updated_by: impl Into<ActorId>,
    ) -> Self {
        let field_versions = value
            .as_object()
            .map(|object| {
                object
                    .keys()
                    .map(|field| (field.clone(), version.clone()))
                    .collect()
            })
            .unwrap_or_default();

        Self {
            key,
            value,
            version,
            field_versions,
            deleted_at: None,
            updated_by: updated_by.into(),
        }
    }

    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub key: RecordKey,
    pub format: SnapshotFormat,
    pub payload: Vec<u8>,
    pub sequence: i64,
    #[serde(default)]
    pub metadata: Value,
    pub updated_at_ms: i64,
}

impl Snapshot {
    pub fn new(
        key: RecordKey,
        sequence: i64,
        payload: Vec<u8>,
        format: impl Into<SnapshotFormat>,
    ) -> Self {
        Self::at(unix_time_ms(), key, sequence, payload, format)
    }

    /// [`Snapshot::new`] with the clock supplied by the caller.
    pub fn at(
        now_ms: i64,
        key: RecordKey,
        sequence: i64,
        payload: Vec<u8>,
        format: impl Into<SnapshotFormat>,
    ) -> Self {
        Self {
            key,
            format: format.into(),
            payload,
            sequence,
            metadata: Value::Null,
            updated_at_ms: now_ms,
        }
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SnapshotUpdate {
    pub key: RecordKey,
    pub format: SnapshotFormat,
    pub payload: Vec<u8>,
    pub sequence: i64,
    #[serde(default)]
    pub metadata: Value,
    pub created_at_ms: i64,
}

impl SnapshotUpdate {
    pub fn new(
        key: RecordKey,
        sequence: i64,
        payload: Vec<u8>,
        format: impl Into<SnapshotFormat>,
    ) -> Self {
        Self::at(unix_time_ms(), key, sequence, payload, format)
    }

    /// [`SnapshotUpdate::new`] with the clock supplied by the caller.
    pub fn at(
        now_ms: i64,
        key: RecordKey,
        sequence: i64,
        payload: Vec<u8>,
        format: impl Into<SnapshotFormat>,
    ) -> Self {
        Self {
            key,
            format: format.into(),
            payload,
            sequence,
            metadata: Value::Null,
            created_at_ms: now_ms,
        }
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SyncCursor {
    pub scope: ScopeId,
    pub remote: RemoteId,
    pub position: i64,
    pub updated_at_ms: i64,
}

impl SyncCursor {
    pub fn new(scope: impl Into<ScopeId>, remote: impl Into<RemoteId>, position: i64) -> Self {
        Self::at(unix_time_ms(), scope, remote, position)
    }

    /// [`SyncCursor::new`] with the clock supplied by the caller.
    pub fn at(
        now_ms: i64,
        scope: impl Into<ScopeId>,
        remote: impl Into<RemoteId>,
        position: i64,
    ) -> Self {
        Self {
            scope: scope.into(),
            remote: remote.into(),
            position,
            updated_at_ms: now_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub id: ConflictId,
    pub key: RecordKey,
    pub operation_id: OperationId,
    pub reason: String,
    pub local_value: Option<Value>,
    pub remote_value: Option<Value>,
    pub created_at_ms: i64,
}

impl Conflict {
    pub fn new(
        key: RecordKey,
        operation_id: OperationId,
        reason: impl Into<String>,
        local_value: Option<Value>,
        remote_value: Option<Value>,
    ) -> Self {
        Self::at(
            unix_time_ms(),
            key,
            operation_id,
            reason,
            local_value,
            remote_value,
        )
    }

    /// [`Conflict::new`] with the clock supplied by the caller.
    pub fn at(
        now_ms: i64,
        key: RecordKey,
        operation_id: OperationId,
        reason: impl Into<String>,
        local_value: Option<Value>,
        remote_value: Option<Value>,
    ) -> Self {
        Self {
            id: ConflictId::random(),
            key,
            operation_id,
            reason: reason.into(),
            local_value,
            remote_value,
            created_at_ms: now_ms,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OperationFilter {
    pub scope: Option<ScopeId>,
    pub collection: Option<CollectionName>,
    pub status: Option<OperationStatus>,
    pub after_remote_sequence: Option<i64>,
    pub limit: Option<usize>,
}

impl OperationFilter {
    pub fn pending_for_scope(scope: impl Into<ScopeId>) -> Self {
        Self {
            scope: Some(scope.into()),
            status: Some(OperationStatus::Pending),
            ..Self::default()
        }
    }
}

/// Wall-clock milliseconds since the Unix epoch.
///
/// Prefer the `*_at(now_ms, ..)` constructors: they keep the clock an argument,
/// which is what makes the projection reproducible in tests and callable from
/// the WASM kernel, where the host owns the clock.
#[cfg(not(target_arch = "wasm32"))]
pub fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// `SystemTime::now()` panics on `wasm32-unknown-unknown`, so read the host clock.
#[cfg(target_arch = "wasm32")]
pub fn unix_time_ms() -> i64 {
    js_date_now() as i64
}

#[cfg(target_arch = "wasm32")]
#[allow(unused)]
mod wasm_clock {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = Date, js_name = now)]
        pub fn now() -> f64;
    }
}

#[cfg(target_arch = "wasm32")]
fn js_date_now() -> f64 {
    wasm_clock::now()
}
