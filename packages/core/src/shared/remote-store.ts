import type { RecordPageRequest, RecordPage, SelectionState, RecordCheckpoint } from '../selection.js'
/**
 * The follower half of a shared store: a `LocalStore` that owns no database
 * and forwards every call to whichever context does.
 *
 * Every forwarded method is idempotent, which is what makes the retry policy
 * below safe. The loads are pure reads, and `commit` is idempotent by
 * construction — operations insert `ON CONFLICT DO NOTHING`, records, cursors
 * and conflicts upsert, status updates are absolute rather than relative. The
 * PGlite adapter's own journal replay already depends on exactly that
 * property, so re-sending a request costs a round trip and nothing else.
 */

import type {
  Collection,
  Conflict,
  EngineRecord,
  OperationStatus,
  RecordId,
  Scope,
  StoredOperation,
} from '../types.js'
import type { CursorRow, LoadRecordsOptions, LocalStore, StoreWrite } from '../store.js'
import {
  deserializeError,
  type RemoteMethod,
  type RequestMessage,
  type StoreChannel,
  type StoreMessage,
} from './protocol.js'

interface InFlight {
  readonly message: RequestMessage
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly startedAt: number
}

export interface RemoteStoreOptions {
  readonly channel: StoreChannel
  /** This context's id, so it can recognize its own echoes. */
  readonly clientId: string
  /**
   * How long the bus may stay *silent* before a call fails.
   *
   * Silence, not elapsed time: an owner that has announced itself resets this,
   * so a slow cold start does not fail requests that were going to be served.
   */
  readonly requestTimeoutMs?: number | undefined
  /** How often an unanswered call is re-posted. */
  readonly retryIntervalMs?: number | undefined
  readonly clock?: (() => number) | undefined
}

/**
 * A `LocalStore` backed by another context.
 *
 * Not exported from the package root: applications reach this through
 * `createSharedLocalStore`, which is the only place that knows whether this
 * context should be a follower at all.
 */
export class RemoteLocalStore implements LocalStore {
  private readonly inFlight = new Map<string, InFlight>()
  private readonly requestTimeoutMs: number
  private readonly retryIntervalMs: number
  private readonly clock: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private nextRequest = 0
  private disposed = false
  /** Last time an owner proved it exists. Zero means we have never heard one. */
  private lastOwnerSignalAt = 0

  constructor(private readonly options: RemoteStoreOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.retryIntervalMs = options.retryIntervalMs ?? 1_500
    this.clock = options.clock ?? (() => Date.now())
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /** Feed a channel message in. Messages for other peers are ignored. */
  handleMessage(message: StoreMessage): void {
    if (message.t === 'hello') {
      this.lastOwnerSignalAt = this.clock()
      // An owner that is still opening its database is alive but cannot
      // answer. Re-posting at it would be noise; the point of hearing from it
      // is that the silence timer no longer counts against us.
      if (message.serving) this.repost()
      return
    }
    if (message.t !== 'res') return
    this.lastOwnerSignalAt = this.clock()
    const entry = this.inFlight.get(message.id)
    if (!entry) return
    this.inFlight.delete(message.id)
    this.stopTimerIfIdle()
    if (message.ok) entry.resolve(message.value)
    else entry.reject(deserializeError(message.error))
  }

  /**
   * Settle everything in flight against a local executor.
   *
   * Called when this context is promoted to owner mid-request: the calls it
   * was waiting on can now be answered here rather than re-sent to a context
   * that no longer exists.
   */
  settleWith(execute: (method: RemoteMethod, args: readonly unknown[]) => Promise<unknown>): void {
    const entries = [...this.inFlight.values()]
    this.inFlight.clear()
    this.stopTimerIfIdle()
    for (const entry of entries) {
      execute(entry.message.method, entry.message.args).then(entry.resolve, entry.reject)
    }
  }

  dispose(reason: string): void {
    if (this.disposed) return
    this.disposed = true
    const entries = [...this.inFlight.values()]
    this.inFlight.clear()
    this.stopTimerIfIdle()
    for (const entry of entries) entry.reject(new Error(reason))
  }

  private call<T>(method: RemoteMethod, args: readonly unknown[]): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('this shared store follower is closed'))
    }
    const id = `${this.options.clientId}:${this.nextRequest++}`
    const message: RequestMessage = { t: 'req', id, from: this.options.clientId, method, args }

    return new Promise<T>((resolve, reject) => {
      this.inFlight.set(id, {
        message,
        resolve: resolve as (value: unknown) => void,
        reject,
        startedAt: this.clock(),
      })
      this.startTimer()
      this.options.channel.post(message)
    })
  }

  /**
   * Re-post everything unanswered, failing whatever the bus has been silent
   * about for too long.
   *
   * The bus has no delivery guarantee and no buffering, so a request posted
   * while the owner was still opening its database is simply gone. Re-posting
   * is the only way to find out — and is free, because every method is
   * idempotent.
   *
   * A request only expires after a stretch of *silence*, measured from the
   * later of when it was made and when an owner last proved it exists. An
   * owner that is slow is not an owner that is missing, and failing a request
   * because a cold PGlite start ran long would take the whole client down for
   * a database that was about to open.
   */
  private repost(): void {
    const now = this.clock()
    for (const [id, entry] of [...this.inFlight]) {
      const silentSince = Math.max(entry.startedAt, this.lastOwnerSignalAt)
      if (now - silentSince > this.requestTimeoutMs) {
        this.inFlight.delete(id)
        entry.reject(
          new Error(
            `no shared store owner answered ${entry.message.method} in ${this.requestTimeoutMs}ms`,
          ),
        )
        continue
      }
      this.options.channel.post(entry.message)
    }
    this.stopTimerIfIdle()
  }

  /**
   * One retry tick: re-send, then ask whether an owner is out there.
   *
   * The probe belongs here and *only* here. Asking from `repost()` would build
   * a loop — an owner answers `who` with `hello`, and `hello` triggers a
   * repost — so the two tabs would trade messages as fast as the bus allows
   * and starve the main thread that is supposed to be opening the database.
   */
  private tick(): void {
    this.repost()
    if (this.inFlight.size) {
      this.options.channel.post({ t: 'who', from: this.options.clientId })
    }
  }

  private startTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), this.retryIntervalMs)
    // Node keeps the process alive for a pending interval; a retry timer is
    // not a reason for a CLI or a test runner to hang.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private stopTimerIfIdle(): void {
    if (this.timer === null || this.inFlight.size > 0) return
    clearInterval(this.timer)
    this.timer = null
  }

  // ---------------------------------------------------------------------------
  // LocalStore
  // ---------------------------------------------------------------------------

  migrate(): Promise<void> {
    return this.call('migrate', [])
  }

  loadRecords(scope: Scope, options?: LoadRecordsOptions): Promise<EngineRecord[]> {
    return this.call('loadRecords', [scope, options])
  }

  readRecordPage(scope: Scope, request: RecordPageRequest): Promise<RecordPage> {
    return this.call('readRecordPage', [scope, request])
  }

  getSelectionMembers(scope: Scope, id: string, afterId: string | null, limit: number): Promise<string[]> {
    return this.call('getSelectionMembers', [scope, id, afterId, limit])
  }

  getSelectionState(scope: Scope, id: string): Promise<SelectionState | null> {
    return this.call('getSelectionState', [scope, id])
  }

  getRecordMemberships(scope: Scope, collection: Collection, recordId: RecordId): Promise<string[]> {
    return this.call('getRecordMemberships', [scope, collection, recordId])
  }

  getDeferredEviction(scope: Scope, collection: Collection, recordId: RecordId): Promise<boolean> {
    return this.call('getDeferredEviction', [scope, collection, recordId])
  }

  getRecordBase(scope: Scope, collection: Collection, recordId: RecordId): Promise<RecordCheckpoint | null> {
    return this.call('getRecordBase', [scope, collection, recordId])
  }

  loadPendingOperations(scope: Scope): Promise<StoredOperation[]> {
    return this.call('loadPendingOperations', [scope])
  }

  loadAcceptedOperations(
    scope: Scope,
    collection: Collection,
    recordId: RecordId,
  ): Promise<StoredOperation[]> {
    return this.call('loadAcceptedOperations', [scope, collection, recordId])
  }

  loadOperationIds(scope: Scope): Promise<string[]> {
    return this.call('loadOperationIds', [scope])
  }

  loadConflicts(scope: Scope): Promise<Conflict[]> {
    return this.call('loadConflicts', [scope])
  }

  getCursor(scope: Scope, remote: string): Promise<CursorRow | null> {
    return this.call('getCursor', [scope, remote])
  }

  commit(write: StoreWrite): Promise<void> {
    return this.call('commit', [write])
  }

  stats(scope: Scope): Promise<{
    operations: Record<OperationStatus, number>
    recordsByCollection: Record<Collection, number>
  }> {
    return this.call('stats', [scope])
  }

  /**
   * `null` here, not a proxy.
   *
   * `raw()` exists so an app can colocate its own tables on the same
   * connection. A follower has no connection, and a fake one that silently
   * dropped writes would be worse than an honest absence.
   */
  raw(): unknown {
    return null
  }

  async close(): Promise<void> {
    this.dispose('this shared store follower is closed')
  }
}
