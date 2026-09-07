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
  CollectionHydration,
  CollectionMode,
  PhotonClient,
  PhotonClientOptions,
  LocalRecordPage,
} from './client.js'

export { newId, uuidV7 } from './id.js'
export { Kernel, KernelUnavailableError } from './kernel.js'
export type { PhotonKernel, PhotonKernelModule, OperationIntent } from './kernel.js'

export { buildRoomId, buildWorkspaceScope, namespacedKey, recordKeyIndex } from './scope.js'
export type { WorkspaceScopeInput } from './scope.js'

export { buildComparator, matchesWhere, readField } from './query.js'
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
  LoadRecordsOptions,
  LocalStore,
  OperationStatusUpdate,
  StoreWrite,
  MembershipWrite,
} from './store.js'

export { createSharedLocalStore, sharedStoreSupported } from './shared/index.js'
export type {
  Election,
  RemoteMethod,
  SharedLocalStore,
  SharedLocalStoreOptions,
  StoreChannel,
  StoreMessage,
} from './shared/index.js'

export { createRestTransport, decisionForError } from './rest/index.js'
export type { RestListResult, RestResource, RestOperationContext, RestTransportOptions } from './rest/index.js'

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
  RemoteChangeHint,
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
  MutationOptions,
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

export { normalizeSelection, validateSelection, sameSelection } from './selection.js'
export type { RecordCheckpoint, OperationReceipt, RecordSelection, SelectionFilter, Scalar, RecordPageRequest, RecordPage, SelectionCursor, SelectionPullRequest, SelectionPullResult, SelectionRemoval, RemovalReason, SelectionState, SyncSubscription } from './selection.js'
