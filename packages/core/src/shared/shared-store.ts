import type { RecordPageRequest, RecordPage, SelectionState, RecordCheckpoint } from '../selection.js'
/**
 * One store, many contexts.
 *
 * PGlite holds a single connection per data directory, and two tabs of the
 * same origin see the same IndexedDB. Opening the store in both corrupts it,
 * and the adapter's `exclusiveLock` only turns that corruption into a loud
 * failure — the second tab still cannot work. This is the other half: exactly
 * one context opens the real store, everyone else talks to it, and when the
 * owner's tab closes the next one in line is promoted and opens it for real.
 *
 * The seam this rides on is `LocalStore` itself. Because it is ~10 idempotent
 * methods rather than a wide database interface, "forward it to another
 * context" is a small object, and the transport underneath is swappable:
 * BroadcastChannel today, a SharedWorker or Tauri's Rust side later, with no
 * change above this file.
 */

import { newId } from '../id.js'
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
import { broadcastChannelAvailable, createBroadcastStoreChannel } from './broadcast-channel.js'
import { electOwner, type Election } from './election.js'
import {
  serializeError,
  type RemoteMethod,
  type StoreChannel,
  type StoreMessage,
} from './protocol.js'
import { RemoteLocalStore } from './remote-store.js'

export interface SharedLocalStoreOptions {
  /**
   * Identifies the store, not the context. Every context that passes the same
   * key coordinates; usually the `dataDir` the underlying store would open.
   */
  readonly key: string

  /**
   * Opens the real store. Called only in the context that wins ownership, and
   * again in a context that is later promoted — so it must be safe to call
   * after another context has already used the same database.
   */
  open(): Promise<LocalStore>

  /** Defaults to a BroadcastChannel named after `key`. */
  readonly channel?: StoreChannel

  /**
   * How ownership is decided. Defaults to a queued Web Lock.
   *
   * Injectable because ownership is not always a lock: a SharedWorker
   * topology has exactly one owner by construction, and a Tauri host already
   * knows that its Rust side owns the store. Tests use it to run several
   * contexts in one process.
   */
  readonly elect?: (name: string, onWin: () => void) => Election

  /**
   * How long to wait, at open time, to find out whether this context is the
   * owner. Exceeding it is not an error: the context proceeds as a follower
   * and is promoted later if it wins.
   */
  readonly ownershipGraceMs?: number

  readonly requestTimeoutMs?: number
  readonly retryIntervalMs?: number
}

export interface SharedLocalStore extends LocalStore {
  /** True while this context holds the real store. */
  readonly isOwner: boolean

  /** Fires when this context is promoted to owner. */
  onOwnershipChange(listener: (isOwner: boolean) => void): () => void

  /**
   * Writes that reached the store from *another* context.
   *
   * A context's own writes are never delivered here — it applied them to its
   * own projection when it made the mutation, and replaying them would emit a
   * spurious remote change.
   */
  subscribe(listener: (write: StoreWrite) => void): () => void
}

export function sharedStoreSupported(): boolean {
  return broadcastChannelAvailable()
}

export async function createSharedLocalStore(
  options: SharedLocalStoreOptions,
): Promise<SharedLocalStore> {
  const store = new SharedStore(options)
  await store.start()
  return store
}

class SharedStore implements SharedLocalStore {
  private readonly clientId = newId('ctx')
  private readonly channel: StoreChannel
  private readonly remote: RemoteLocalStore
  private readonly election: Election
  private readonly unsubscribeChannel: () => void
  private readonly writeListeners = new Set<(write: StoreWrite) => void>()
  private readonly ownershipListeners = new Set<(isOwner: boolean) => void>()

  private local: LocalStore | null = null
  private promoting = false
  /** In flight while this context is opening the store, so `close()` can wait. */
  private promotion: Promise<void> | null = null
  private failure: Error | null = null
  private closed = false
  private onOwnerReady: (() => void) | null = null

  constructor(private readonly options: SharedLocalStoreOptions) {
    this.channel =
      options.channel ??
      (() => {
        if (!broadcastChannelAvailable()) {
          throw new Error(
            'Photon: a shared local store needs BroadcastChannel, or an explicit `channel`.',
          )
        }
        return createBroadcastStoreChannel(`photon-store:${options.key}`)
      })()

    this.remote = new RemoteLocalStore({
      channel: this.channel,
      clientId: this.clientId,
      requestTimeoutMs: options.requestTimeoutMs,
      retryIntervalMs: options.retryIntervalMs,
    })

    this.unsubscribeChannel = this.channel.subscribe((message) => this.handleMessage(message))
    const elect = options.elect ?? electOwner
    this.election = elect(`photon-shared-store:${options.key}`, () => {
      this.promotion = this.promote().finally(() => {
        this.promotion = null
      })
    })
  }

  /**
   * Settle the common cases before returning, so a single tab never pays a
   * round trip and a second tab does not start by talking into the void.
   *
   * Neither outcome is required: a context that learns nothing here proceeds
   * as a follower, and its first requests are re-posted when an owner
   * announces itself.
   */
  async start(): Promise<void> {
    if (this.local || this.promoting) return

    const ready = new Promise<void>((resolve) => {
      this.onOwnerReady = resolve
    })
    // Anyone already serving answers this, which is faster than waiting out
    // the grace period.
    this.channel.post({ t: 'who', from: this.clientId })

    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.ownershipGraceMs ?? 250)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    await Promise.race([ready, grace])
    if (timer !== undefined) clearTimeout(timer)
    this.onOwnerReady = null
  }

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------

  get isOwner(): boolean {
    return this.local !== null
  }

  onOwnershipChange(listener: (isOwner: boolean) => void): () => void {
    this.ownershipListeners.add(listener)
    return () => this.ownershipListeners.delete(listener)
  }

  private async promote(): Promise<void> {
    if (this.closed || this.local || this.promoting) return
    this.promoting = true
    // Announced before the database is open, not after. Opening PGlite on a
    // cold cache runs for seconds, and a follower that hears nothing in that
    // window cannot tell a slow owner from an absent one.
    this.channel.post({ t: 'hello', from: this.clientId, serving: false })
    try {
      const local = await this.options.open()
      if (this.closed) {
        await local.close()
        return
      }
      this.local = local
      // Anything this context was waiting on can be answered here now. The
      // owner it was addressed to may no longer exist.
      this.remote.settleWith((method, args) => this.executeLocal(method, args))
      // Only once `local` is set, or a follower re-posting on this would be
      // answered by a context that still cannot serve.
      this.channel.post({ t: 'hello', from: this.clientId, serving: true })
      for (const listener of [...this.ownershipListeners]) listener(true)
      this.onOwnerReady?.()
    } catch (error) {
      // Holding the lock without being able to serve would strand every other
      // context behind a store that never opens. Stand down so the next one
      // can try, and fail this context's own calls rather than hang them.
      this.failure = error instanceof Error ? error : new Error(String(error))
      console.error(`Photon: failed to open the shared store ${this.options.key}`, error)
      this.election.close()
      this.remote.dispose(`the shared store ${this.options.key} could not be opened`)
      this.onOwnerReady?.()
    } finally {
      this.promoting = false
    }
  }

  // ---------------------------------------------------------------------------
  // Channel
  // ---------------------------------------------------------------------------

  private handleMessage(message: StoreMessage): void {
    if (message.from === this.clientId) return

    switch (message.t) {
      case 'who':
        // Only the owner answers, which is what makes the bus self-addressing.
        // An owner that is still opening answers as well, so that a follower
        // that missed the election announcement still learns one is coming.
        if (this.local || this.promoting) {
          this.channel.post({ t: 'hello', from: this.clientId, serving: this.local !== null })
        }
        return

      case 'hello':
        this.onOwnerReady?.()
        this.remote.handleMessage(message)
        return

      case 'req':
        if (!this.local) return // A follower is not the addressee; ignore.
        void this.serve(message.id, message.from, message.method, message.args)
        return

      case 'write':
        this.notifyWrite(message.write)
        return

      case 'res':
        this.remote.handleMessage(message)
        return
    }
  }

  private async serve(
    id: string,
    from: string,
    method: RemoteMethod,
    args: readonly unknown[],
  ): Promise<void> {
    try {
      const value = await this.executeLocal(method, args)
      this.channel.post({ t: 'res', id, from: this.clientId, ok: true, value })
      if (method === 'commit') this.announceWrite(args[0] as StoreWrite, from)
    } catch (error) {
      this.channel.post({
        t: 'res',
        id,
        from: this.clientId,
        ok: false,
        error: serializeError(error),
      })
    }
  }

  private executeLocal(method: RemoteMethod, args: readonly unknown[]): Promise<unknown> {
    const local = this.local
    if (!local) return Promise.reject(new Error('this context does not own the shared store'))
    switch (method) {
      case 'migrate':
        return local.migrate()
      case 'loadRecords':
        return local.loadRecords(args[0] as Scope, args[1] as LoadRecordsOptions | undefined)
      case 'loadPendingOperations':
        return local.loadPendingOperations(args[0] as Scope)
      case 'loadAcceptedOperations':
        return local.loadAcceptedOperations(
          args[0] as Scope,
          args[1] as Collection,
          args[2] as RecordId,
        )
      case 'loadOperationIds':
        return local.loadOperationIds(args[0] as Scope)
      case 'loadConflicts':
        return local.loadConflicts(args[0] as Scope)
      case 'readRecordPage':
        if (!local.readRecordPage) return Promise.reject(new Error('store does not support readRecordPage'))
        return local.readRecordPage(args[0] as Scope, args[1] as RecordPageRequest)
      case 'getSelectionMembers':
        if (!local.getSelectionMembers) return Promise.reject(new Error('store does not support selection memberships'))
        return local.getSelectionMembers(args[0] as Scope, args[1] as string, args[2] as string | null, args[3] as number)
      case 'getSelectionState':
        if (!local.getSelectionState) return Promise.reject(new Error('store does not support getSelectionState'))
        return local.getSelectionState(args[0] as Scope, args[1] as string)
      case 'getRecordMemberships':
        if (!local.getRecordMemberships) return Promise.reject(new Error('store does not support getRecordMemberships'))
        return local.getRecordMemberships(args[0] as Scope, args[1] as Collection, args[2] as RecordId)
      case 'getDeferredEviction':
        if (!local.getDeferredEviction) return Promise.reject(new Error('store does not support deferred evictions'))
        return local.getDeferredEviction(args[0] as Scope, args[1] as Collection, args[2] as RecordId)
      case 'getRecordBase':
        if (!local.getRecordBase) return Promise.reject(new Error('store does not support getRecordBase'))
        return local.getRecordBase(args[0] as Scope, args[1] as Collection, args[2] as RecordId)
      case 'getCursor':
        return local.getCursor(args[0] as Scope, args[1] as string)
      case 'commit':
        return local.commit(args[0] as StoreWrite)
      case 'stats':
        return local.stats(args[0] as Scope)
      default:
        return Promise.reject(new Error(`unknown shared store method ${String(method)}`))
    }
  }

  /**
   * Tell everyone a write landed.
   *
   * `from` is the context that issued it, not the one that applied it, so the
   * rule is uniform everywhere: a context reacts to a write unless it is its
   * own. That is what lets the owner learn about a follower's mutation through
   * the same path a follower learns about the owner's.
   */
  private announceWrite(write: StoreWrite, from: string): void {
    this.channel.post({ t: 'write', from, write })
    if (from !== this.clientId) this.notifyWrite(write)
  }

  private notifyWrite(write: StoreWrite): void {
    for (const listener of [...this.writeListeners]) {
      try {
        listener(write)
      } catch (error) {
        console.error('Photon: a shared store write listener threw', error)
      }
    }
  }

  subscribe(listener: (write: StoreWrite) => void): () => void {
    this.writeListeners.add(listener)
    return () => this.writeListeners.delete(listener)
  }

  // ---------------------------------------------------------------------------
  // LocalStore
  // ---------------------------------------------------------------------------

  private backend(): LocalStore {
    if (this.failure) throw this.failure
    return this.local ?? this.remote
  }

  migrate(): Promise<void> {
    return this.backend().migrate()
  }

  loadRecords(scope: Scope, options?: LoadRecordsOptions): Promise<EngineRecord[]> {
    return this.backend().loadRecords(scope, options)
  }

  readRecordPage(scope: Scope, request: RecordPageRequest): Promise<RecordPage> {
    const backend = this.backend()
    if (!backend.readRecordPage) return Promise.reject(new Error('store does not support readRecordPage'))
    return backend.readRecordPage(scope, request)
  }

  getSelectionMembers(scope: Scope, id: string, afterId: string | null, limit: number): Promise<string[]> {
    const backend = this.backend()
    if (!backend.getSelectionMembers) return Promise.reject(new Error('store does not support selection memberships'))
    return backend.getSelectionMembers(scope, id, afterId, limit)
  }

  getSelectionState(scope: Scope, id: string): Promise<SelectionState | null> {
    const backend = this.backend()
    if (!backend.getSelectionState) return Promise.reject(new Error('store does not support getSelectionState'))
    return backend.getSelectionState(scope, id)
  }

  getRecordMemberships(scope: Scope, collection: Collection, recordId: RecordId): Promise<string[]> {
    const backend = this.backend()
    if (!backend.getRecordMemberships) return Promise.reject(new Error('store does not support getRecordMemberships'))
    return backend.getRecordMemberships(scope, collection, recordId)
  }

  getDeferredEviction(scope: Scope, collection: Collection, recordId: RecordId): Promise<boolean> {
    const backend = this.backend()
    if (!backend.getDeferredEviction) return Promise.reject(new Error('store does not support deferred evictions'))
    return backend.getDeferredEviction(scope, collection, recordId)
  }

  getRecordBase(scope: Scope, collection: Collection, recordId: RecordId): Promise<RecordCheckpoint | null> {
    const backend = this.backend()
    if (!backend.getRecordBase) return Promise.reject(new Error('store does not support getRecordBase'))
    return backend.getRecordBase(scope, collection, recordId)
  }

  loadPendingOperations(scope: Scope): Promise<StoredOperation[]> {
    return this.backend().loadPendingOperations(scope)
  }

  loadAcceptedOperations(
    scope: Scope,
    collection: Collection,
    recordId: RecordId,
  ): Promise<StoredOperation[]> {
    return this.backend().loadAcceptedOperations(scope, collection, recordId)
  }

  loadOperationIds(scope: Scope): Promise<string[]> {
    return this.backend().loadOperationIds(scope)
  }

  loadConflicts(scope: Scope): Promise<Conflict[]> {
    return this.backend().loadConflicts(scope)
  }

  getCursor(scope: Scope, remote: string): Promise<CursorRow | null> {
    return this.backend().getCursor(scope, remote)
  }

  async commit(write: StoreWrite): Promise<void> {
    const backend = this.backend()
    await backend.commit(write)
    // A follower's commit is announced by the owner that applied it, once it
    // is durable there. Announcing it here too would double-deliver.
    if (backend === this.local) this.announceWrite(write, this.clientId)
  }

  stats(scope: Scope): Promise<{
    operations: Record<OperationStatus, number>
    recordsByCollection: Record<Collection, number>
  }> {
    return this.backend().stats(scope)
  }

  /** The real handle when this context owns it, `null` while it is a follower. */
  raw(): unknown {
    return this.local?.raw() ?? null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.remote.dispose('this shared store is closed')
    this.unsubscribeChannel()
    this.writeListeners.clear()
    this.ownershipListeners.clear()

    // Order matters: releasing ownership promotes the next context, and it
    // opens the database immediately. Doing that before this one has closed
    // its connection would put two connections on the same data directory —
    // exactly the corruption this whole file exists to prevent.
    //
    // A promotion still in flight counts as holding the connection. It has
    // already seen `closed`, so it will close whatever it opened, but it has
    // to get there first: releasing the lock mid-open hands the directory to
    // the next context while this one is still acquiring it.
    if (this.promotion) await this.promotion
    const local = this.local
    this.local = null
    if (local) await local.close()
    this.election.close()

    this.channel.close()
  }
}
