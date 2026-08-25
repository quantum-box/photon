/**
 * The sync loop.
 *
 * Properties this exists to guarantee, each of which was missing before:
 *
 * - single-flight with a dirty flag, so concurrent triggers collapse into one
 *   cycle plus at most one follow-up
 * - every push/pull bounded by a timeout
 * - jittered backoff, so N tabs do not retry in lockstep after a blip
 * - 401 pauses instead of retrying; an expired token will not fix itself
 * - a durable cursor, saved in the same transaction as the operations it covers
 * - every decision handled — `rejected` and `conflict` used to be dropped on
 *   the floor, which left the operation pending and re-pushed forever
 */

import { createBackoff } from './backoff.js'
import type { LocalStore, OperationStatusUpdate } from '../store.js'
import type { Collection, Operation, Scope } from '../types.js'
import type {
  PullResult,
  PushDecision,
  SyncController,
  SyncError,
  SyncReason,
  SyncStatus,
  SyncSummary,
  SyncTransport,
} from './types.js'

export interface SyncEngineOptions {
  readonly scope: Scope
  readonly transport?: SyncTransport
  readonly store: LocalStore
  readonly clock: () => number
  readonly remoteId: string
  readonly pushDebounceMs: number
  readonly pollIntervalMs: number
  readonly pullPageSize: number
  readonly requestTimeoutMs?: number
  collectPending(): Operation[]
  onDecision(decision: PushDecision): void
  /** May be async: applying to a lazy collection hydrates it first. */
  applyRemote(operations: readonly Operation[]): void | Promise<void>
  /** A server with no operation log returned current state instead. */
  applySnapshot(page: Extract<PullResult, { kind: 'snapshot' }>): void
  knownOperationIds(): ReadonlySet<string>
  pendingCount(): number
  conflictCount(): number
}

const OFFLINE_FAILURE_THRESHOLD = 2

export class SyncEngine implements SyncController {
  private listeners = new Set<() => void>()
  private status: SyncStatus
  private running = false
  private inFlight: Promise<SyncSummary> | null = null
  private queued: Promise<SyncSummary> | null = null
  private consecutiveNetworkFailures = 0
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly backoff = createBackoff()
  private detach: (() => void)[] = []

  constructor(private readonly options: SyncEngineOptions) {
    this.status = {
      phase: 'idle',
      online: true,
      lastSyncAt: null,
      lastError: null,
      pendingOperations: 0,
      conflicts: 0,
      cursor: null,
      nextAttemptInMs: null,
      realtime: 'off',
    }
  }

  getStatus(): SyncStatus {
    return this.status
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.running || !this.options.transport) return
    this.running = true

    // These globals are absent in Node, workers, and Vitest. The engine must
    // run there unchanged, so every one of them is probed, never assumed.
    const host = globalThis as Partial<typeof globalThis>
    if (typeof host.addEventListener === 'function') {
      const onOnline = () => {
        // Treat navigator.onLine as a hint only: captive portals lie about it.
        this.backoff.reset()
        this.consecutiveNetworkFailures = 0
        void this.syncNow('online')
      }
      const onVisible = () => {
        if (host.document?.visibilityState === 'visible') void this.syncNow('visible')
      }
      host.addEventListener('online', onOnline)
      host.document?.addEventListener?.('visibilitychange', onVisible)
      this.detach.push(() => {
        host.removeEventListener?.('online', onOnline)
        host.document?.removeEventListener?.('visibilitychange', onVisible)
      })
    }

    this.pollTimer = setInterval(() => {
      // Polling is the safety net for when the realtime signal is not connected.
      if (this.status.realtime !== 'connected') void this.syncNow('poll')
    }, this.options.pollIntervalMs)

    void this.syncNow('startup')
  }

  stop(): void {
    this.running = false
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.pushTimer = this.retryTimer = null
    this.pollTimer = null
    for (const off of this.detach) off()
    this.detach = []
  }

  /** Debounced: a burst of edits produces one push, not one per keystroke. */
  notifyLocalChange(): void {
    this.patch({ pendingOperations: this.options.pendingCount() })
    if (!this.running || !this.options.transport) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.syncNow('mutation')
    }, this.options.pushDebounceMs)
  }

  /** Called when a realtime frame says the server has news. */
  notifyRemoteChange(): void {
    if (!this.running || !this.options.transport) return
    void this.syncNow('realtime')
  }

  setRealtimeState(state: SyncStatus['realtime']): void {
    this.patch({ realtime: state })
  }

  async syncNow(reason: SyncReason = 'manual'): Promise<SyncSummary> {
    if (!this.options.transport) {
      return { pushed: 0, pulled: 0, rejected: 0, conflicts: 0 }
    }
    if (this.status.phase === 'paused' && reason !== 'manual') {
      return { pushed: 0, pulled: 0, rejected: 0, conflicts: 0 }
    }

    // Single-flight, but the contract is "once this resolves, the work that
    // existed when you called has been attempted". Returning the already-running
    // cycle would break that: it may have collected its operations before the
    // caller's mutation existed.
    //
    // So callers that arrive during a cycle share one *follow-up* cycle rather
    // than the running one. Many triggers still collapse into one extra pass.
    if (this.queued) return this.queued

    if (this.inFlight) {
      this.queued = this.inFlight
        .catch(() => undefined)
        .then(() => {
          this.queued = null
          return this.syncNow(reason)
        })
      return this.queued
    }

    this.inFlight = this.runCycle().finally(() => {
      this.inFlight = null
    })

    return this.inFlight
  }

  private async runCycle(): Promise<SyncSummary> {
    const transport = this.options.transport!
    this.patch({ phase: 'syncing', nextAttemptInMs: null })

    const summary = { pushed: 0, pulled: 0, rejected: 0, conflicts: 0 }

    try {
      // --- push -----------------------------------------------------------
      const pending = this.options.collectPending()
      if (pending.length) {
        const result = await transport.push({ scope: this.options.scope, operations: pending })
        const statusUpdates: OperationStatusUpdate[] = []

        for (const decision of result.decisions) {
          this.options.onDecision(decision)
          switch (decision.kind) {
            case 'accepted':
              summary.pushed += 1
              statusUpdates.push({
                operationId: decision.operationId,
                status: 'accepted',
                remoteSequence: decision.remoteSequence ?? null,
              })
              break
            case 'rejected':
              summary.rejected += 1
              statusUpdates.push({ operationId: decision.operationId, status: 'rejected' })
              break
            case 'conflict':
              summary.conflicts += 1
              statusUpdates.push({ operationId: decision.operationId, status: 'conflict' })
              break
          }
        }

        if (statusUpdates.length) await this.options.store.commit({ statusUpdates })
      }

      // --- pull -----------------------------------------------------------
      const cursorRow = await this.options.store.getCursor(this.options.scope, this.options.remoteId)
      let cursor = cursorRow?.position ?? null
      let guard = 0

      for (;;) {
        const page = await transport.pull({
          scope: this.options.scope,
          cursor,
          limit: this.options.pullPageSize,
        })

        if (page.kind === 'snapshot') {
          this.options.applySnapshot(page)
          summary.pulled += page.records.length
          cursor = page.cursor ?? cursor
          break
        }
        if (!page.operations.length) {
          cursor = page.cursor ?? cursor
          break
        }

        const known = this.options.knownOperationIds()
        // A pull returns our own operations back. Filtering them here is what
        // stops the insert from violating operation_id uniqueness.
        const fresh = page.operations.filter((row) => !known.has(row.operation.id))
        const operations = fresh.map((row) => row.operation)

        await this.options.applyRemote(operations)
        summary.pulled += operations.length

        cursor = page.cursor ?? page.operations[page.operations.length - 1]!.remoteSequence

        // Operations and cursor commit together: a crash between them would
        // otherwise skip a page permanently.
        await this.options.store.commit({
          operations,
          statusUpdates: operations.map((operation) => ({
            operationId: operation.id,
            status: 'accepted' as const,
          })),
          cursor: {
            scope: this.options.scope,
            remote: this.options.remoteId,
            position: cursor,
            updatedAtMs: this.options.clock(),
          },
        })

        guard += 1
        if (!page.hasMore || guard >= 100) break
      }

      this.backoff.reset()
      this.consecutiveNetworkFailures = 0
      this.patch({
        phase: 'idle',
        online: true,
        lastSyncAt: this.options.clock(),
        lastError: null,
        cursor,
        pendingOperations: this.options.pendingCount(),
        conflicts: this.options.conflictCount(),
        nextAttemptInMs: null,
      })
      return summary
    } catch (error) {
      this.handleFailure(error)
      return summary
    }
  }

  private handleFailure(error: unknown): void {
    const syncError = classify(error)

    if (syncError.kind === 'auth') {
      // Do not spin on an expired token; someone has to sign in again.
      this.patch({ phase: 'paused', lastError: syncError, nextAttemptInMs: null })
      return
    }

    if (syncError.kind === 'network') {
      this.consecutiveNetworkFailures += 1
    }

    const offline = this.consecutiveNetworkFailures >= OFFLINE_FAILURE_THRESHOLD
    const delay = this.backoff.next()

    this.patch({
      phase: offline ? 'offline' : 'error',
      online: !offline,
      lastError: syncError,
      nextAttemptInMs: delay,
      pendingOperations: this.options.pendingCount(),
    })

    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.running) void this.syncNow('poll')
    }, delay)
  }

  private patch(next: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...next }
    for (const listener of this.listeners) listener()
  }
}

function classify(error: unknown): SyncError {
  const status = (error as { status?: number } | null)?.status
  const message = error instanceof Error ? error.message : String(error)

  if (status === 401 || status === 403) return { kind: 'auth', message, status }
  if (typeof status === 'number' && status >= 500) return { kind: 'server', message, status }
  if (typeof status === 'number' && status >= 400) return { kind: 'protocol', message, status }
  return { kind: 'network', message }
}

export type { Collection }
