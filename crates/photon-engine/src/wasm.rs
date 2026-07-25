//! The Photon kernel as seen from JavaScript.
//!
//! This is deliberately a *synchronous, storage-free* surface. The kernel owns
//! operation construction, CRDT projection, and clock causality; the host owns
//! storage, scheduling, and I/O. Keeping storage out means there is exactly one
//! async world — the host's — and no `!Send` storage trait to thread through
//! the native engine just to satisfy a JS-backed adapter.
//!
//! Every entry point that needs the wall clock takes it as an argument, so the
//! host stays the single source of time and tests stay reproducible.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{
    projection::apply_operation,
    types::{ActorId, HybridTimestamp, Operation, OperationKind, Record, RecordKey},
};

fn to_js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

/// A mutation the host wants performed, before it becomes an [`Operation`].
#[derive(Debug, Deserialize)]
pub struct Intent {
    pub key: RecordKey,
    pub kind: OperationKind,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// One page of remote operations, applied against the records the host holds.
#[derive(Debug, Deserialize)]
pub struct RemoteBatch {
    pub operations: Vec<Operation>,
    /// Current projections for every record the batch touches.
    #[serde(default)]
    pub records: Vec<Record>,
    /// Operation ids the host has already durably applied.
    ///
    /// A pull returns the caller's own operations back, so without this the
    /// host would re-apply them and violate its own `operation_id` uniqueness.
    #[serde(default)]
    pub applied_operation_ids: Vec<String>,
    pub now_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct RemoteBatchResult {
    pub records: Vec<Record>,
    pub applied_operation_ids: Vec<String>,
    pub skipped_operation_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ReplayResult {
    pub record: Option<Record>,
}

fn key_index(key: &RecordKey) -> String {
    format!("{}\u{1f}{}\u{1f}{}", key.scope, key.collection, key.record_id)
}

/// The synchronous semantic kernel.
///
/// One instance per Photon client. It carries the actor id and the hybrid
/// clock; it carries no storage and performs no I/O.
#[wasm_bindgen]
pub struct PhotonKernel {
    actor_id: ActorId,
    clock: RefCell<HybridTimestamp>,
}

#[wasm_bindgen]
impl PhotonKernel {
    #[wasm_bindgen(constructor)]
    pub fn new(actor_id: String, now_ms: f64) -> PhotonKernel {
        let actor_id = ActorId::from(actor_id);
        PhotonKernel {
            clock: RefCell::new(HybridTimestamp::at(now_ms as i64, actor_id.clone())),
            actor_id,
        }
    }

    #[wasm_bindgen(js_name = actorId)]
    pub fn actor_id(&self) -> String {
        self.actor_id.to_string()
    }

    /// Turn an intent into a fully-formed operation, advancing the hybrid clock.
    #[wasm_bindgen(js_name = buildOperation)]
    pub fn build_operation(&self, intent_json: &str, now_ms: f64) -> Result<String, JsValue> {
        let intent: Intent = serde_json::from_str(intent_json).map_err(to_js)?;

        let timestamp = {
            let mut clock = self.clock.borrow_mut();
            *clock = clock.tick_at(now_ms as i64, self.actor_id.clone());
            clock.clone()
        };

        let mut operation =
            Operation::at(now_ms as i64, intent.key, self.actor_id.clone(), intent.kind)
                .with_timestamp(timestamp);

        if let Some(id) = intent.operation_id {
            operation = operation.with_id(id);
        }
        if let Some(metadata) = intent.metadata {
            operation = operation.with_metadata(metadata);
        }

        serde_json::to_string(&operation).map_err(to_js)
    }

    /// Project one operation onto a record.
    #[wasm_bindgen(js_name = applyOperation)]
    pub fn apply_operation(
        &self,
        current_json: Option<String>,
        operation_json: &str,
    ) -> Result<String, JsValue> {
        let current = current_json
            .map(|json| serde_json::from_str::<Record>(&json))
            .transpose()
            .map_err(to_js)?;
        let operation: Operation = serde_json::from_str(operation_json).map_err(to_js)?;
        let record = apply_operation(current, &operation).map_err(to_js)?;
        serde_json::to_string(&record).map_err(to_js)
    }

    /// Fold an ordered run of operations into a single record.
    ///
    /// Used for startup rehydration and, critically, for rollback: a rejected
    /// operation is undone by replaying only the accepted ones, which preserves
    /// any concurrent remote edit that landed in between. Restoring a saved
    /// "previous value" would silently clobber that edit.
    #[wasm_bindgen]
    pub fn replay(
        &self,
        current_json: Option<String>,
        operations_json: &str,
    ) -> Result<String, JsValue> {
        let mut record = current_json
            .map(|json| serde_json::from_str::<Record>(&json))
            .transpose()
            .map_err(to_js)?;
        let operations: Vec<Operation> = serde_json::from_str(operations_json).map_err(to_js)?;

        for operation in &operations {
            record = Some(apply_operation(record, operation).map_err(to_js)?);
        }

        serde_json::to_string(&ReplayResult { record }).map_err(to_js)
    }

    /// Apply a whole pull page at once.
    ///
    /// Crossing the JS boundary per operation costs a serde round-trip of the
    /// full record every time; crossing once per page does not.
    #[wasm_bindgen(js_name = applyRemoteBatch)]
    pub fn apply_remote_batch(&self, batch_json: &str) -> Result<String, JsValue> {
        let batch: RemoteBatch = serde_json::from_str(batch_json).map_err(to_js)?;
        let now_ms = batch.now_ms as i64;
        let already: HashSet<String> = batch.applied_operation_ids.into_iter().collect();

        let mut records: BTreeMap<String, Record> = batch
            .records
            .into_iter()
            .map(|record| (key_index(&record.key), record))
            .collect();

        let mut applied = Vec::new();
        let mut skipped = Vec::new();

        for operation in &batch.operations {
            let operation_id = operation.id.to_string();
            if already.contains(&operation_id) {
                skipped.push(operation_id);
                continue;
            }

            let index = key_index(&operation.key);
            let next = apply_operation(records.get(&index).cloned(), operation).map_err(to_js)?;
            records.insert(index, next);
            applied.push(operation_id);

            self.observe_timestamp_inner(&operation.timestamp, now_ms);
        }

        serde_json::to_string(&RemoteBatchResult {
            records: records.into_values().collect(),
            applied_operation_ids: applied,
            skipped_operation_ids: skipped,
        })
        .map_err(to_js)
    }

    /// Advance the local clock past a timestamp observed from another actor.
    #[wasm_bindgen(js_name = observeTimestamp)]
    pub fn observe_timestamp(&self, timestamp_json: &str, now_ms: f64) -> Result<(), JsValue> {
        let timestamp: HybridTimestamp = serde_json::from_str(timestamp_json).map_err(to_js)?;
        self.observe_timestamp_inner(&timestamp, now_ms as i64);
        Ok(())
    }

    /// The current hybrid clock reading, for debugging and tests.
    #[wasm_bindgen(js_name = currentTimestamp)]
    pub fn current_timestamp(&self) -> Result<String, JsValue> {
        serde_json::to_string(&*self.clock.borrow()).map_err(to_js)
    }
}

impl PhotonKernel {
    fn observe_timestamp_inner(&self, other: &HybridTimestamp, now_ms: i64) {
        let mut clock = self.clock.borrow_mut();
        *clock = clock.observe(other, now_ms, self.actor_id.clone());
    }
}
