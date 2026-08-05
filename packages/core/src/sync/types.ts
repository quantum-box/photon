/**
 * The sync boundary.
 *
 * The engine defines this interface and never calls `fetch` itself. That is
 * what makes a staged migration possible: the same client code runs against a
 * server that speaks the engine protocol, against a plain REST API, or against
 * nothing at all.
 */

import type {
  AckResult,
  Collection,
  EngineRecord,
  Operation,
  OperationId,
  Scope,
} from '../types.js'

export interface PushRequest {
  readonly scope: Scope
  readonly operations: readonly Operation[]
  readonly signal?: AbortSignal
}

/**
 * A per-operation verdict.
 *
 * Mapping HTTP status codes onto this is the main value a REST adapter adds:
 * once a backend's answer is expressed here, rollback, conflict rows and error
 * surfacing all work identically whether or not the server speaks the engine
 * protocol.
 */
export type PushDecision =
  | { readonly kind: 'accepted'; readonly operationId: OperationId; readonly remoteSequence?: number; readonly aliasRecordId?: string }
  | { readonly kind: 'rejected'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'conflict'; readonly operationId: OperationId; readonly reason: string; readonly remoteValue?: unknown }

export interface PushResult {
  readonly decisions: readonly PushDecision[]
}

/**
 * The remote answered, but its payload cannot be reconciled safely.
 *
 * This is deliberately distinct from a network failure: retrying is safe
 * because no local operation status is changed until the complete decision
 * set has passed validation.
 */
export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncProtocolError'
  }
}

export interface PullRequest {
  readonly scope: Scope
  readonly cursor: number | null
  readonly limit: number
  readonly collections?: readonly Collection[]
  readonly signal?: AbortSignal
}

export interface PulledOperation {
  readonly operation: Operation
  readonly remoteSequence: number
}

export interface RemoteRecord {
  readonly collection: Collection
  readonly recordId: string
  readonly value: unknown
  readonly deleted?: boolean
  readonly updatedAtMs?: number
}

/**
 * Servers that keep an operation log return `operations`. Servers that only
 * expose current state return `snapshot`, and the engine converts it into
 * remote upserts.
 */
export type PullResult =
  | {
      readonly kind: 'operations'
      readonly operations: readonly PulledOperation[]
      readonly cursor: number | null
      readonly hasMore?: boolean
    }
  | {
      readonly kind: 'snapshot'
      readonly records: readonly RemoteRecord[]
      readonly cursor?: number | null
      /**
       * True only when these records are the *entire* collection. It is what
       * makes "deleted on the server" distinguishable from "not on this page",
       * so a paginated list must never claim it.
       */
      readonly complete: boolean
      readonly collection: Collection
    }

export interface SyncTransport {
  push(request: PushRequest): Promise<PushResult>
  pull(request: PullRequest): Promise<PullResult>
}

export type SyncReason =
  | 'mutation'
  | 'realtime'
  | 'poll'
  | 'online'
  | 'visible'
  | 'manual'
  | 'startup'

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'paused'

export interface SyncError {
  /**
   * `auth` stops the retry loop entirely. Backing off an expired token just
   * burns battery until someone signs in again.
   */
  readonly kind: 'network' | 'auth' | 'server' | 'protocol'
  readonly message: string
  readonly status?: number
}

export interface SyncStatus {
  readonly phase: SyncPhase
  readonly online: boolean
  readonly lastSyncAt: number | null
  readonly lastError: SyncError | null
  readonly pendingOperations: number
  readonly conflicts: number
  readonly cursor: number | null
  readonly nextAttemptInMs: number | null
  readonly realtime: 'connected' | 'connecting' | 'disconnected' | 'off'
}

export interface SyncSummary {
  readonly pushed: number
  readonly pulled: number
  readonly rejected: number
  readonly conflicts: number
}

export interface SyncController {
  getStatus(): SyncStatus
  subscribe(listener: () => void): () => void
  syncNow(reason?: SyncReason): Promise<SyncSummary>
  /**
   * A realtime frame said the server has news. No-op unless the loop is
   * running: a stopped loop must stay stopped, realtime or not.
   */
  notifyRemoteChange(): void
  /**
   * Mirror the realtime channel's connection state. While `connected`, the
   * poll timer stands down; anything else re-arms polling as the safety net.
   */
  setRealtimeState(state: SyncStatus['realtime']): void
  start(): void
  stop(): void
}

export type AckListener = (result: AckResult) => void

/** Returned by a snapshot pull once converted into engine records. */
export interface SnapshotProjection {
  readonly records: readonly EngineRecord[]
  readonly removedRecordIds: readonly string[]
}
