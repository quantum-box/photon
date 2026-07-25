/**
 * `@quantum-box/photon` — a local-first sync engine.
 *
 * Framework-agnostic on purpose. Nothing in this package imports React, PGlite,
 * or Vite, and nothing reads `window`, `localStorage`, or `import.meta.env` at
 * module scope, so it runs unchanged in a browser, Node, a Web Worker, Vitest,
 * and Tauri.
 */

export { createPhotonClient } from './client.js'
export type {
  CollectionConfig,
  CollectionMode,
  PhotonClient,
  PhotonClientOptions,
} from './client.js'

export { newId, uuidV7 } from './id.js'
export { Kernel, KernelUnavailableError } from './kernel.js'
export type { PhotonKernel, PhotonKernelModule, OperationIntent } from './kernel.js'

export { buildRoomId, buildWorkspaceScope, namespacedKey, recordKeyIndex } from './scope.js'
export type { WorkspaceScopeInput } from './scope.js'

export { buildComparator, matchesWhere } from './query.js'
export type {
  Comparison,
  LiveQuery,
  OrderBy,
  QueryDescriptor,
  QueryState,
  QueryStatus,
  WhereClause,
} from './query.js'

export type {
  CursorRow,
  LocalStore,
  OperationStatusUpdate,
  StoreWrite,
} from './store.js'

export { createBackoff } from './sync/backoff.js'
export type { Backoff, BackoffOptions } from './sync/backoff.js'
export { createEngineTransport, SyncHttpError } from './sync/engine-transport.js'
export type { EngineTransportOptions } from './sync/engine-transport.js'
export type {
  PullRequest,
  PullResult,
  PulledOperation,
  PushDecision,
  PushRequest,
  PushResult,
  RemoteRecord,
  SyncController,
  SyncError,
  SyncPhase,
  SyncReason,
  SyncStatus,
  SyncSummary,
  SyncTransport,
} from './sync/types.js'

export type {
  AckResult,
  ActorId,
  ChangeOrigin,
  ChangeSet,
  Collection,
  Conflict,
  ConflictResolution,
  EngineRecord,
  HybridTimestamp,
  Mutation,
  MutationHandle,
  Operation,
  OperationId,
  OperationKind,
  OperationStatus,
  PhotonRecord,
  RecordChange,
  RecordId,
  RecordKey,
  Scope,
  StoredOperation,
  Unsubscribe,
} from './types.js'
