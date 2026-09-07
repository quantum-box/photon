import type { Operation } from '../types.js'
import { normalizeSelection, sameSelection } from '../selection.js'
import type { RecordSelection, SelectionPullResult, SelectionState, SyncSubscription } from '../selection.js'
import type { LocalStore } from '../store.js'
import type { SyncTransport } from './types.js'

interface Options {
  readonly scope: string
  readonly store: LocalStore
  readonly transport: SyncTransport
  readonly pageSize: number
  readonly pageBudget: number
  readonly clock: () => number
  release(state: SelectionState): Promise<void>
  pendingOperations(): Operation[]
  apply(page: SelectionPullResult, state: SelectionState): Promise<void>
}

/** Serializes all interests so a slow response cannot overwrite a newer base. */
export class SelectionManager {
  private readonly handles = new Map<string, SelectionSubscription>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly options: Options) {}

  open(id: string, selection: RecordSelection): SyncSubscription {
    if (this.closed) throw new Error('Photon client is closed')
    if (!id || id.length > 256) throw new Error('subscription id is required (max 256 characters)')
    if (this.handles.has(id)) throw new Error('subscription id is already active')
    const selector = normalizeSelection(selection)
    const handle = new SelectionSubscription(id, selector, this.options, (run) => {
      const pending = this.tail.then(run)
      this.tail = pending.catch(() => {})
      return pending
    }, () => this.handles.delete(id))
    this.handles.set(id, handle)
    return handle
  }

  async refreshAll(): Promise<void> {
    for (const handle of this.handles.values()) await handle.refresh()
  }

  async drain(): Promise<void> { await this.tail }

  close(): void {
    this.closed = true
    for (const handle of this.handles.values()) handle.close()
  }
}

class SelectionSubscription implements SyncSubscription {
  private snapshot: SelectionState & { error: Error | null }
  private readonly listeners = new Set<() => void>()
  private inFlight: Promise<void> | null = null
  private closed = false
  private readonly controller = new AbortController()
  private readonly loaded: Promise<void>

  constructor(
    id: string, selector: RecordSelection, private readonly options: Options,
    private readonly serial: (run: () => Promise<void>) => Promise<void>,
    private readonly onClose: () => void,
  ) {
    this.snapshot = { scope: options.scope, id, selector, cursor: null, status: 'uninitialized', updatedAtMs: null, error: null }
    this.loaded = options.store.getSelectionState!(options.scope, id).then(stored => {
      if (stored && !sameSelection(stored.selector, selector)) throw new Error('subscription id belongs to a different selector; use a new id')
      if (stored) this.snapshot = { ...stored, error: null }
      this.notify()
    })
    // The error is observable before any network request, including offline.
    void this.loaded.catch(error => this.fail(error))
  }

  getSnapshot(): SelectionState & { error: Error | null } { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  close(): void { this.closed = true; this.controller.abort(); this.listeners.clear(); this.onClose() }

  async release(): Promise<void> {
    this.close()
    await this.serial(async () => { await this.loaded; await this.options.release(this.snapshot) })
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('subscription is closed'))
    if (this.inFlight) return this.inFlight
    this.inFlight = this.serial(async () => {
      await this.loaded
      for (let pageNumber = 0; pageNumber < this.options.pageBudget; pageNumber++) {
        if (this.closed) return
        const previous = this.snapshot.cursor
        const pending = this.options.pendingOperations()
        if (pending.length > 1000) throw new Error('drain the pending queue below 1001 operations before a scoped pull')
        const page = await this.options.transport.pullSelection!({
          scope: this.options.scope, selector: this.snapshot.selector, cursor: previous,
          limit: this.options.pageSize, pendingOperations: pending, signal: this.controller.signal,
        })
        if (this.closed) return
        if (page.cursor.scope !== this.options.scope || !sameSelection(page.cursor.selector, this.snapshot.selector) ||
            !['snapshot', 'delta'].includes(page.cursor.phase) ||
            !Number.isSafeInteger(page.cursor.position) || page.cursor.position < (previous?.position ?? 0) ||
            (!page.hasMore && page.cursor.phase !== 'delta')) throw new Error('invalid selection cursor')
        if ((previous?.phase === 'delta' && page.cursor.phase === 'snapshot') ||
            (previous?.phase === 'snapshot' && page.cursor.phase === 'snapshot' && (!page.cursor.afterId || page.cursor.afterId <= (previous.afterId ?? '')))) throw new Error('selection cursor regressed')
        const recordIds = new Set(page.records.map(r => r.record.key.record_id))
        const removedIds = new Set(page.removals.map(r => r.recordId))
        if (recordIds.size !== page.records.length || removedIds.size !== page.removals.length || page.removals.some(r => recordIds.has(r.recordId) || !['deleted', 'out_of_scope', 'revoked'].includes(r.reason))) throw new Error('invalid selection records/removals')
        if ((page.receipts ?? []).some(receipt => !pending.some(op => op.id === receipt.operationId) || !Number.isSafeInteger(receipt.remoteSequence) || receipt.remoteSequence < 1)) throw new Error('invalid selection receipt')
        if (page.records.some(r => !Number.isSafeInteger(r.sequence) || r.sequence < 0)) throw new Error('invalid record checkpoint')
        if (page.records.some(r => r.record.key.scope !== this.options.scope || r.record.key.collection !== this.snapshot.selector.collection)) throw new Error('selection response crossed scope or collection')
        if (page.hasMore && JSON.stringify(page.cursor) === JSON.stringify(previous)) throw new Error('selection cursor made no progress')
        const state: SelectionState = {
          scope: this.snapshot.scope, id: this.snapshot.id, selector: this.snapshot.selector,
          cursor: page.cursor, status: page.hasMore ? 'partial' : 'complete', updatedAtMs: this.options.clock(),
        }
        await this.options.apply(page, state)
        this.snapshot = { ...state, error: null }
        this.notify()
        if (!page.hasMore) return
      }
    }).catch(error => { this.fail(error); throw error }).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private fail(error: unknown): void {
    this.snapshot = { ...this.snapshot, error: error instanceof Error ? error : new Error(String(error)) }
    this.notify()
  }
  private notify(): void { for (const listener of this.listeners) listener() }
}
