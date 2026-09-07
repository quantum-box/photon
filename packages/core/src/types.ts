/**
 * The wire and storage vocabulary of the engine.
 *
 * These shapes are mirrored by `crates/photon-engine`; both sides serialize the
 * same JSON. The conformance test asserts byte equality, so do not "tidy" a
 * field name here without changing the Rust side too.
 */

export type Collection = string
export type RecordId = string
export type Scope = string
export type ActorId = string
export type OperationId = string

export interface RecordKey {
  readonly scope: Scope
  readonly collection: Collection
  readonly record_id: RecordId
}

export interface HybridTimestamp {
  readonly wall_time_ms: number
  readonly counter: number
  readonly actor_id: ActorId
}

/** The engine's own record shape, as the kernel produces it. */
export interface EngineRecord {
  readonly key: RecordKey
  readonly value: unknown
  readonly version: HybridTimestamp
  readonly field_versions: Readonly<Record<string, HybridTimestamp>>
  readonly deleted_at: HybridTimestamp | null
  readonly updated_by: ActorId
}

export type OperationKind =
  | { type: 'upsert'; value: unknown }
  | { type: 'patch'; fields: Record<string, unknown> }
  | { type: 'remove_fields'; fields: string[] }
  | { type: 'delete' }
  | { type: 'restore'; value?: unknown }
  | { type: 'increment'; field: string; by: number }
  | { type: 'set_add'; field: string; values: unknown[] }
  | { type: 'set_remove'; field: string; values: unknown[] }

export interface Operation {
  readonly id: OperationId
  readonly key: RecordKey
  readonly actor_id: ActorId
  readonly timestamp: HybridTimestamp
  readonly kind: OperationKind
  readonly metadata?: unknown
}

export type OperationStatus = 'pending' | 'accepted' | 'rejected' | 'conflict'

export interface StoredOperation {
  readonly operation: Operation
  readonly status: OperationStatus
  readonly localSequence: number
  readonly remoteSequence: number | null
  readonly receivedAtMs: number
}

/**
 * A record as the application sees it.
 *
 * `pending` and `durable` are the two facts a local-first UI actually needs and
 * that a plain REST cache cannot express: whether the server has acknowledged
 * this write, and whether it would survive a reload.
 */
export interface PhotonRecord<T = unknown> {
  readonly key: RecordKey
  readonly value: T
  readonly version: HybridTimestamp
  readonly fieldVersions: Readonly<Record<string, HybridTimestamp>>
  readonly deletedAt: HybridTimestamp | null
  readonly updatedBy: ActorId
  /** An operation on this record has not been acknowledged by the server. */
  readonly pending: boolean
  /** The optimistic write has reached local durable storage. */
  readonly durable: boolean
  /** Set when the server assigned a different id than the one created locally. */
  readonly aliasOf?: RecordId
}

export interface Conflict {
  readonly id: string
  readonly key: RecordKey
  readonly operationId: OperationId
  readonly reason: string
  readonly localValue: unknown
  readonly remoteValue: unknown
  readonly createdAtMs: number
}

export type ConflictResolution = { keep: 'local' } | { keep: 'remote' } | { keep: 'value'; value: unknown }

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface MutationOptions {
  /** An application/server version (for example an ETag), stable across retries. */
  readonly expectedVersion?: string | number
}

export interface Mutation extends MutationOptions {
  readonly collection: Collection
  readonly recordId: RecordId
  readonly kind: OperationKind
}

export type AckResult =
  | { readonly status: 'accepted'; readonly operationId: OperationId }
  | { readonly status: 'rejected'; readonly operationId: OperationId; readonly reason: string }
  | { readonly status: 'conflict'; readonly operationId: OperationId; readonly conflictId: string }

export interface MutationHandle<T = unknown> {
  readonly operationId: OperationId
  /**
   * Available synchronously, before this call returns. This is what makes a
   * click reflect in the UI in the same tick rather than after a round trip.
   */
  readonly optimistic: PhotonRecord<T> | null
  /** Resolves once the write has reached local durable storage. */
  readonly local: Promise<PhotonRecord<T> | null>
  /** Resolves once the server has decided. */
  readonly settled: Promise<AckResult>
  /**
   * Undo by issuing inverse operations, never by restoring a saved value:
   * a concurrent remote edit may have landed in between.
   */
  rollback(): Promise<void>
}

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

export type ChangeOrigin = 'local' | 'remote' | 'rollback' | 'hydrate' | 'ingest'

export interface RecordChange<T = unknown> {
  readonly collection: Collection
  readonly recordId: RecordId
  readonly previous: PhotonRecord<T> | null
  readonly next: PhotonRecord<T> | null
}

export interface ChangeSet {
  readonly origin: ChangeOrigin
  readonly changes: readonly RecordChange[]
  readonly collections: readonly Collection[]
}

export type Unsubscribe = () => void
