import { SelectionManager } from './sync/selections.js'
import type { RecordSelection, RecordPageRequest, SelectionPullResult, SelectionState, SyncSubscription } from './selection.js'
/**
 * The Photon client.
 *
 * Mutation path, in order, and the order is the point:
 *
 *   kernel.buildOperation()   synchronous
 *   kernel.applyOperation()   synchronous
 *   projection update         synchronous
 *   ChangeSet emitted         synchronous  <- subscribers see it in this tick
 *   durable write queued      async
 *   sync loop picks it up     async
 *
 * Because the ChangeSet is emitted before this function returns, a click
 * handler's effect is on screen before the browser paints. That is stronger
 * than React's `useOptimistic`: the value survives unmount, is shared by every
 * component showing the record, and outlives navigation.
 */

import { Kernel, KernelUnavailableError } from './kernel.js'
import type { PhotonKernelModule } from './kernel.js'
import { newId } from './id.js'
import { Projection } from './projection.js'
import { CollectionQuery, RecordQuery } from './query.js'
import type { LiveQuery, QueryDescriptor, QueryState, QueryStatus } from './query.js'
import { createRestTransport } from './rest/index.js'
import type { RestResource } from './rest/index.js'
import type { LocalStore, StoreWrite } from './store.js'
import { SyncEngine } from './sync/controller.js'
import { createModeRouterTransport } from './sync/mode-router.js'
import type { PullResult, PushDecision, SyncController, SyncTransport } from './sync/types.js'
import type {
  AckResult,
  ChangeSet,
  Collection,
  Conflict,
  ConflictResolution,
  EngineRecord,
  HybridTimestamp,
  Mutation,
  MutationOptions,
  MutationHandle,
  Operation,
  PhotonRecord,
  RecordChange,
  RecordId,
  Scope,
  Unsubscribe,
} from './types.js'

export type CollectionMode = 'engine-native' | 'rest-backed' | 'passthrough'

/**
 * When a collection's stored records enter the projection.
 *
 * - `eager` (default) — loaded during `bootstrap()`, before the client is
 *   handed to the caller. Right for the structural collections a workspace
 *   shell needs on first paint: databases, views, members.
 * - `lazy` — skipped at bootstrap and loaded on the first `query()` /
 *   `liveRecord()` touching the collection, or by an explicit
 *   `hydrateCollection()`. Right for record-heavy collections, so startup
 *   cost is proportional to workspace structure, not record count.
 *
 * Pending (unpushed) operations are always restored at bootstrap regardless
 * of hydration mode — laziness must never lose an offline write.
 *
 * One caveat: patching an *existing* record in a lazy collection before it
 * hydrates merges against an absent base. Reads trigger hydration, so any
 * flow that shows a record before editing it is safe; a write-only flow
 * should `await hydrateCollection()` first.
 */
export type CollectionHydration = 'eager' | 'lazy' | 'on-demand'

/**
 * Per-collection sync behavior. The staged-adoption story is this one line:
 *
 * - `passthrough` — the REST resource does everything. No durable log, no
 *   offline queue: a mutation is applied optimistically and pushed inline,
 *   and a transport failure rejects it. Zero backend change.
 * - `rest-backed` — same REST resource, but writes go through the durable
 *   operation log, so they queue offline, survive reload, and roll back on
 *   rejection. Merge is last-write-wins at the REST boundary.
 * - `engine-native` — the server speaks the engine protocol; field-level CRDT
 *   merge applies. Served by the client's `transport`.
 *
 * Component code never changes across the three.
 */
export type CollectionConfig =
  | { readonly mode: 'engine-native'; readonly hydration?: CollectionHydration }
  | {
      readonly mode: 'rest-backed'
      readonly resource: RestResource<never>
      readonly hydration?: CollectionHydration
    }
  | {
      readonly mode: 'passthrough'
      readonly resource: RestResource<never>
      readonly hydration?: CollectionHydration
    }

export interface PhotonClientOptions {
  /** Opaque to the engine; only ever compared for equality. */
  readonly scope: Scope
  /** Stable per device+user. Two tabs of one user are still one actor. */
  readonly actorId: string
  readonly storage: LocalStore
  readonly kernel: PhotonKernelModule
  readonly transport?: SyncTransport
  readonly collections?: Readonly<Record<Collection, CollectionConfig>>
  /**
   * Config for a collection that `collections` does not name.
   *
   * Some applications do not know their collection set when the client is
   * built: data is partitioned per project, per board, per repository, and the
   * partitions are discovered at runtime — often from data the client itself
   * holds. Enumerating them up front would mean either a network round trip
   * before the client exists, or rebuilding the client whenever the set
   * changes, and neither survives an offline start.
   *
   * The resolver is consulted once per collection the client encounters, and
   * the answer is cached for the client's lifetime. Return `undefined` to take
   * the default (`engine-native`).
   *
   * ```ts
   * resolveCollection: (collection) => {
   *   const id = collection.startsWith('data:') ? collection.slice(5) : null
   *   return id ? { mode: 'rest-backed', resource: dataResource(id) } : undefined
   * }
   * ```
   *
   * One limit worth knowing: `bootstrap()` skips lazy collections by name, and
   * a resolved collection has no name to skip until something asks for it. Its
   * stored records therefore load with the eager ones on a warm start. Its
   * remote data still arrives through `pull`, and `hydration: 'lazy'` still
   * governs everything after bootstrap.
   */
  readonly resolveCollection?: (collection: Collection) => CollectionConfig | undefined
  readonly cache?: { readonly maxRecords: number }
  readonly sync?: {
    /** Scoped mode never runs the legacy full-scope pull. */
    readonly mode?: 'full' | 'scoped'
    readonly selectionPageBudget?: number
    readonly autoStart?: boolean
    readonly pushDebounceMs?: number
    readonly pollIntervalMs?: number
    readonly pullPageSize?: number
    readonly remoteId?: string
  }
  /** Injectable so tests are deterministic. */
  readonly clock?: () => number
  readonly onChange?: (changes: ChangeSet) => void
}

export interface LocalRecordPage<T = unknown> {
  readonly data: readonly PhotonRecord<T>[]
  readonly hasMore: boolean
  readonly nextAfterId: string | null
}

export interface PhotonClient {
  readonly scope: Scope
  readonly actorId: string
  readonly storage: LocalStore
  readonly sync: SyncController

  subscribeSync(id: string, selector: RecordSelection): SyncSubscription
  readPage<T = unknown>(request: RecordPageRequest): Promise<LocalRecordPage<T>>
  /** Evict memory only; pending and actively subscribed records are pinned. */
  evictRecords(collection: Collection, recordIds: readonly RecordId[]): number
  query<T = unknown>(descriptor: QueryDescriptor<T>): LiveQuery<PhotonRecord<T>[]>
  liveRecord<T = unknown>(collection: Collection, recordId: RecordId): LiveQuery<PhotonRecord<T> | null>

  /**
   * Load a lazy collection's stored records into the projection. Idempotent
   * and safe to call for eager collections, where it resolves immediately.
   * Queries trigger this on their own; call it directly to prefetch.
   */
  hydrateCollection(collection: Collection): Promise<void>

  mutate<T = unknown>(mutation: Mutation): MutationHandle<T>
  /** One ChangeSet, one durable transaction, one push batch. */
  transact(mutations: readonly Mutation[], options?: { atomic?: boolean }): MutationHandle<void>

  upsert<T = unknown>(collection: Collection, recordId: RecordId, value: T, options?: MutationOptions): MutationHandle<T>
  /** Pass only the fields that changed: per-field merge depends on it. */
  patch<T = unknown>(collection: Collection, recordId: RecordId, fields: Partial<T>, options?: MutationOptions): MutationHandle<T>
  removeFields<T = unknown>(collection: Collection, recordId: RecordId, fields: string[]): MutationHandle<T>
  remove<T = unknown>(collection: Collection, recordId: RecordId): MutationHandle<T>
  restore<T = unknown>(collection: Collection, recordId: RecordId, value?: T): MutationHandle<T>
  increment<T = unknown>(collection: Collection, recordId: RecordId, field: string, by: number): MutationHandle<T>
  setAdd<T = unknown>(collection: Collection, recordId: RecordId, field: string, values: unknown[]): MutationHandle<T>
  setRemove<T = unknown>(collection: Collection, recordId: RecordId, field: string, values: unknown[]): MutationHandle<T>

  /** uuid v7, so the id is final from the moment of creation. */
  newId(prefix?: string): RecordId

  /** Feed externally fetched data in without writing operations. */
  ingest<T = unknown>(
    collection: Collection,
    items: readonly { recordId: RecordId; value: T; deleted?: boolean }[],
    options?: { complete?: boolean },
  ): void

  conflicts(collection?: Collection): readonly Conflict[]
  resolveConflict(conflictId: string, resolution: ConflictResolution): Promise<void>

  subscribeChanges(listener: (changes: ChangeSet) => void): Unsubscribe
  pendingCount(): number
  close(): Promise<void>
}

interface PendingEntry {
  readonly operation: Operation
  resolve(result: AckResult): void
}

/**
 * PGlite holds a single connection per data directory. Two clients on the same
 * directory corrupt each other, so fail loudly rather than subtly.
 */
const liveClients = new Set<string>()

export async function createPhotonClient(options: PhotonClientOptions): Promise<PhotonClient> {
  const clock = options.clock ?? (() => Date.now())

  let kernel: Kernel
  try {
    kernel = new Kernel(new options.kernel.PhotonKernel(options.actorId, clock()), clock)
  } catch (error) {
    throw new KernelUnavailableError(error)
  }

  const client = new PhotonClientImpl(options, kernel, clock)
  await client.bootstrap()
  return client
}

class PhotonClientImpl implements PhotonClient {
  readonly scope: Scope
  readonly actorId: string
  readonly storage: LocalStore

  private readonly projection: Projection
  private readonly collectionQueries = new Map<Collection, Set<CollectionQuery<never>>>()
  private readonly recordQueries = new Map<Collection, Set<RecordQuery<never>>>()
  private readonly changeListeners = new Set<(changes: ChangeSet) => void>()
  private readonly pending = new Map<string, PendingEntry>()
  private readonly appliedOperationIds = new Set<string>()
  private conflictRows: Conflict[] = []

  private hydrateResolve!: () => void
  readonly hydrated = new Promise<void>((resolve) => {
    this.hydrateResolve = resolve
  })

  private notifyScheduled = false
  private dirtyCollections = new Set<Collection>()
  private closed = false
  private unsubscribeStorage: (() => void) | null = null
  private readonly registryKey: string
  private readonly collectionModes = new Map<Collection, CollectionMode>()
  private readonly lazyCollections = new Set<Collection>()
  private selections: SelectionManager | null = null
  private readonly onDemandCollections = new Set<Collection>()
  private readonly accessOrder = new Map<string, { collection: Collection; recordId: RecordId }>()
  private readonly removalInFlight = new Map<string, number>()
  private readonly localWrites = new Set<Promise<unknown>>()
  private writeTail: Promise<void> = Promise.resolve()
  private readonly durableOperationIds = new Set<string>()
  private readonly hydratedLazyCollections = new Set<Collection>()
  private readonly hydrationInFlight = new Map<Collection, Promise<void>>()
  /** Resources of rest-backed and passthrough collections, added to as the
   * `resolveCollection` resolver answers. */
  private readonly restResources: Record<Collection, RestResource<never>> = {}
  /** Wraps the REST resources of rest-backed and passthrough collections. */
  private readonly restTransport: SyncTransport | null

  readonly sync: SyncEngine

  constructor(
    private readonly options: PhotonClientOptions,
    private readonly kernel: Kernel,
    private readonly clock: () => number,
  ) {
    this.scope = options.scope
    this.actorId = options.actorId
    this.storage = options.storage
    this.projection = new Projection(options.scope)

    this.registryKey = `${options.scope}::${String((options.storage.raw() as { dataDir?: string })?.dataDir ?? '')}`
    if (liveClients.has(this.registryKey)) {
      throw new Error(
        `A Photon client is already open for ${this.registryKey}. Local storage allows a ` +
          'single connection; close the existing client before creating another.',
      )
    }
    liveClients.add(this.registryKey)

    // Held, not copied: `applyCollectionConfig` adds to it as the resolver
    // answers, and `createRestTransport` reads it per request rather than
    // capturing its keys, so a collection discovered later is pullable.
    for (const [collection, config] of Object.entries(options.collections ?? {})) {
      this.applyCollectionConfig(collection, config)
    }

    this.restTransport =
      Object.keys(this.restResources).length || options.resolveCollection
        ? createRestTransport({
            resources: this.restResources,
            readRecord: (collection, recordId) => this.projection.get(collection, recordId)?.value,
          })
        : null

    const transport = createModeRouterTransport({
      ...(options.transport ? { engine: options.transport } : {}),
      ...(this.restTransport ? { rest: this.restTransport } : {}),
      modeOf: (collection) => this.modeOf(collection),
    })

    if (options.sync?.mode === 'scoped') {
      const pageSize = options.sync.pullPageSize ?? 200
      const pageBudget = options.sync.selectionPageBudget ?? 100
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(pageBudget) || pageBudget < 1) {
        liveClients.delete(this.registryKey)
        throw new Error('scoped sync requires pageSize 1..1000 and a positive pageBudget')
      }
      if (!transport?.pullSelection || !this.storage.readRecordPage || !this.storage.getSelectionState ||
          !this.storage.getSelectionMembers || !this.storage.getRecordMemberships || !this.storage.getRecordBase || !this.storage.getDeferredEviction) {
        liveClients.delete(this.registryKey)
        throw new Error('scoped sync requires selection transport and extended local storage')
      }
      this.selections = new SelectionManager({
        scope: this.scope, store: this.storage, transport,
        clock, pageSize: options.sync?.pullPageSize ?? 200,
        pageBudget: options.sync?.selectionPageBudget ?? 100,
        release: (state) => this.releaseSelection(state),
        pendingOperations: () => [...this.pending.values()].filter(entry => this.durableOperationIds.has(entry.operation.id)).map(entry => entry.operation),
        apply: (page, state) => this.applySelectionPage(page, state),
      })
    }
    this.sync = new SyncEngine({
      commitDecisions: (decisions, updates) => this.commitDecisions(decisions, updates),
      beforePush: () => Promise.all([...this.localWrites]).then(() => undefined),
      ...(this.selections ? { pullSelections: () => this.selections!.refreshAll() } : {}),
      scope: options.scope,
      ...(transport ? { transport } : {}),
      store: options.storage,
      clock,
      remoteId: options.sync?.remoteId ?? 'photon-server',
      pushDebounceMs: options.sync?.pushDebounceMs ?? 150,
      pollIntervalMs: options.sync?.pollIntervalMs ?? 30_000,
      pullPageSize: options.sync?.pullPageSize ?? 200,
      // Passthrough operations are pushed inline at mutation time and have no
      // durable queue, so the sync loop must never re-push them.
      collectPending: () =>
        [...this.pending.values()]
          .map((entry) => entry.operation)
          .filter((operation) => this.modeOf(operation.key.collection) !== 'passthrough' && this.durableOperationIds.has(operation.id)),
      onDecision: (decision) => this.handleDecision(decision),
      applyRemote: (operations) => this.applyRemoteOperations(operations),
      applySnapshot: (page) => this.applySnapshot(page),
      knownOperationIds: () => this.appliedOperationIds,
      pendingCount: () => this.pending.size,
      conflictCount: () => this.conflictRows.length,
    })
  }

  /**
   * Register one collection's config. Idempotent, and safe to call after the
   * client is running: the REST transport reads `restResources` per request.
   */
  private applyCollectionConfig(collection: Collection, config: CollectionConfig): void {
    this.collectionModes.set(collection, config.mode)
    if (config.hydration === 'lazy' || config.hydration === 'on-demand') this.lazyCollections.add(collection)
    if (config.hydration === 'on-demand') this.onDemandCollections.add(collection)
    if (config.mode === 'engine-native') return
    // Runtime guard for plain-JS callers: the union type cannot save them.
    if (!('resource' in config) || !config.resource) {
      throw new Error(
        `Collection "${collection}" is configured as "${config.mode}" but has no REST resource`,
      )
    }
    this.restResources[collection] = config.resource
  }

  private modeOf(collection: Collection): CollectionMode {
    const known = this.collectionModes.get(collection)
    if (known) return known

    // Ask the resolver once per collection, then remember the answer —
    // including "no answer", so a resolver is never called twice for the same
    // name and cannot make `modeOf` non-deterministic mid-session.
    const resolved = this.options.resolveCollection?.(collection)
    if (resolved) {
      this.applyCollectionConfig(collection, resolved)
      return resolved.mode
    }
    this.collectionModes.set(collection, 'engine-native')
    return 'engine-native'
  }

  async bootstrap(): Promise<void> {
    await this.storage.migrate()

    // Lazy collections are the record-heavy ones; skipping them here is what
    // makes startup cost proportional to workspace structure, not data size.
    if (this.options.cache && (!Number.isInteger(this.options.cache.maxRecords) || this.options.cache.maxRecords < 1)) throw new Error('maxRecords must be a positive integer')
    const lazy = [...this.lazyCollections]
    const [records, pendingOps, operationIds, conflicts] = await Promise.all([
      this.storage.loadRecords(this.scope, lazy.length ? { excludeCollections: lazy } : undefined),
      this.storage.loadPendingOperations(this.scope),
      this.selections ? Promise.resolve([]) : this.storage.loadOperationIds(this.scope),
      this.storage.loadConflicts(this.scope),
    ])

    for (const id of operationIds) this.appliedOperationIds.add(id)
    this.conflictRows = conflicts

    const changes: RecordChange[] = []
    for (const record of records) {
      this.kernel.observeTimestamp(record.version)
      const change = this.projection.set(record, { durable: true })
      if (change) changes.push(change)
    }

    // Pending operations were durably stored but never acknowledged.
    // Re-registering them — for lazy collections too — is what keeps `pending`
    // true across a reload and gets them re-pushed; an unpushed write must
    // never be lost to deferred hydration. For an eager collection its effects
    // are already in the projection; for a lazy one they arrive with the
    // stored record when the collection hydrates.
    for (const stored of pendingOps) {
      this.durableOperationIds.add(stored.operation.id)
      this.registerPending(stored.operation)
      const change = this.projection.addPending(
        stored.operation.key.collection,
        stored.operation.key.record_id,
      )
      if (change) changes.push(change)
    }

    // Restore only the pending records for on-demand collections, never their
    // entire collection. Ordinary accepted records remain in the store.
    for (const stored of pendingOps) {
      if (this.onDemandCollections.has(stored.operation.key.collection)) {
        await this.hydrateRecord(stored.operation.key.collection, stored.operation.key.record_id)
      }
    }
    this.hydrateResolve()
    this.emit('hydrate', changes)

    // A store shared across tabs reports what the other tabs wrote. Folding
    // those in is the difference between two tabs that both work and two tabs
    // that agree: without it, a sibling's edit stays invisible until it has
    // been pushed to the server and pulled back.
    this.unsubscribeStorage =
      this.storage.subscribe?.((write) => this.applyExternalWrite(write)) ?? null

    if (this.options.sync?.autoStart !== false) this.sync.start()
  }

  /**
   * Project a write another context made against the same store.
   *
   * The records are taken as-is rather than re-derived from the operations:
   * the context that wrote them already ran them through the kernel, and
   * re-merging here would apply the same operation twice.
   */
  private applyExternalWrite(write: StoreWrite): void {
    if (this.closed) return

    const changes: RecordChange[] = []

    for (const record of write.records ?? []) {
      // A lazy collection that has not hydrated has no base to merge against,
      // and it will read this record from storage when it does hydrate.
      // Projecting it now would put a lone record into an empty collection and
      // make it look complete.
      if (
        this.lazyCollections.has(record.key.collection) &&
        !this.hydratedLazyCollections.has(record.key.collection)
      ) {
        continue
      }
      const change = this.projection.set(record, { durable: true })
      if (change) changes.push(change)
    }

    for (const target of write.deleteRecords ?? []) {
      const change = this.projection.remove(target.collection, target.recordId)
      if (change) changes.push(change)
    }

    // Their effect is already in the records above, so a later pull echoing
    // them back must not re-apply it.
    for (const operation of write.operations ?? []) {
      this.durableOperationIds.add(operation.id)
      this.appliedOperationIds.add(operation.id)
      // Another context's unpushed write is pending for this client too — the
      // operations were loaded from the same store at bootstrap.
      if (!this.pending.has(operation.id)) {
        this.registerPending(operation)
        const change = this.projection.addPending(
          operation.key.collection,
          operation.key.record_id,
        )
        if (change) changes.push(change)
      }
    }

    for (const update of write.statusUpdates ?? []) {
      if (update.status === 'pending') continue
      const entry = this.pending.get(update.operationId)
      if (!entry) continue
      this.pending.delete(update.operationId)
      const change = this.projection.releasePending(
        entry.operation.key.collection,
        entry.operation.key.record_id,
      )
      if (change) changes.push(change)
    }

    if (write.conflicts?.length) {
      const known = new Set(this.conflictRows.map((conflict) => conflict.id))
      this.conflictRows = [
        ...this.conflictRows,
        ...write.conflicts.filter((conflict) => !known.has(conflict.id)),
      ]
    }
    if (write.resolveConflictIds?.length) {
      const resolved = new Set(write.resolveConflictIds)
      this.conflictRows = this.conflictRows.filter((conflict) => !resolved.has(conflict.id))
    }

    this.emit('remote', changes)
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  query<T = unknown>(descriptor: QueryDescriptor<T>): LiveQuery<PhotonRecord<T>[]> {
    // Subscribing is what pulls a lazy collection in; the query stays
    // `loading` until its collection's stored records are in the projection.
    if (this.onDemandCollections.has(descriptor.collection)) throw new Error('use readPage() for on-demand collections')
    const collectionReady = this.hydrateCollection(descriptor.collection)
    const query = new CollectionQuery<T>(
      descriptor,
      {
        recordsIn: (collection) => this.projection.recordsIn(collection) as Iterable<PhotonRecord<T>>,
        hydrated: collectionReady,
      },
      (target) => {
        this.collectionQueries.get(target.collection)?.delete(target as never)
      },
    )

    let bucket = this.collectionQueries.get(descriptor.collection)
    if (!bucket) {
      bucket = new Set()
      this.collectionQueries.set(descriptor.collection, bucket)
    }
    bucket.add(query as never)

    query.invalidate(this.collectionStatus(descriptor.collection))
    void collectionReady.then(() => {
      if (query.invalidate('ready')) query.notify()
    })

    return query
  }

  liveRecord<T = unknown>(
    collection: Collection,
    recordId: RecordId,
  ): LiveQuery<PhotonRecord<T> | null> {
    const collectionReady = this.onDemandCollections.has(collection) ? this.hydrateRecord(collection, recordId) : this.hydrateCollection(collection)
    const query = new RecordQuery<T>(
      collection,
      recordId,
      (c, id) => this.projection.get(c, id) as PhotonRecord<T> | null,
      collectionReady,
      (target) => {
        this.recordQueries.get(target.collection)?.delete(target as never)
      },
    )

    let bucket = this.recordQueries.get(collection)
    if (!bucket) {
      bucket = new Set()
      this.recordQueries.set(collection, bucket)
    }
    bucket.add(query as never)

    query.invalidate(this.collectionStatus(collection))
    void collectionReady.then(() => {
      if (query.invalidate('ready')) query.notify()
    })

    return query
  }

  private isHydrated = false

  private collectionStatus(collection: Collection): QueryStatus {
    if (this.onDemandCollections.has(collection)) return 'ready'
    if (this.lazyCollections.has(collection)) {
      return this.hydratedLazyCollections.has(collection) ? 'ready' : 'loading'
    }
    return this.isHydrated ? 'ready' : 'loading'
  }

  hydrateCollection(collection: Collection): Promise<void> {
    if (this.onDemandCollections.has(collection)) return Promise.reject(new Error('use readPage() for on-demand collections'))
    if (!this.lazyCollections.has(collection) || this.hydratedLazyCollections.has(collection)) {
      return this.hydrated
    }
    const inFlight = this.hydrationInFlight.get(collection)
    if (inFlight) return inFlight

    const run = this.loadLazyCollection(collection).finally(() => {
      this.hydrationInFlight.delete(collection)
    })
    this.hydrationInFlight.set(collection, run)
    return run
  }

  private async loadLazyCollection(collection: Collection): Promise<void> {
    const records = await this.storage.loadRecords(this.scope, { collection })
    // A complete snapshot may have hydrated the collection while this load was
    // in flight; its rows are then stale and must not resurrect anything.
    if (this.closed || this.hydratedLazyCollections.has(collection)) return

    const changes: RecordChange[] = []
    for (const record of records) {
      const existing = this.projection.get(collection, record.key.record_id)
      // A mutation, ingest, or pull can outrun this load. What is in memory
      // is then ahead of the stored row: optimistic or non-durable state
      // always wins, and among durable states the newer version wins.
      if (
        existing &&
        (existing.pending ||
          !existing.durable ||
          !isNewerVersion(record.version, existing.version))
      ) {
        continue
      }
      const change = this.projection.set(record, { durable: true })
      if (change) changes.push(change)
    }

    this.hydratedLazyCollections.add(collection)
    this.emit('hydrate', changes)
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  mutate<T = unknown>(mutation: Mutation): MutationHandle<T> {
    return this.applyMutations<T>([mutation])
  }

  transact(mutations: readonly Mutation[], options?: { atomic?: boolean }): MutationHandle<void> {
    if (options?.atomic && (!this.options.transport?.supportsAtomic || mutations.some(m => this.modeOf(m.collection) !== 'engine-native'))) {
      throw new Error('atomic batches require a single atomic engine transport')
    }
    return this.applyMutations<void>(mutations, options?.atomic === true)
  }

  private applyMutations<T>(mutations: readonly Mutation[], atomic = false): MutationHandle<T> {
    if (this.closed) throw new Error('Photon client is closed')
    if (atomic && mutations.length > 1000) throw new Error('atomic batches support at most 1000 operations')
    if (!mutations.length) throw new Error('transact() requires at least one mutation')

    for (const mutation of mutations) {
      if (this.removalInFlight.has(JSON.stringify([mutation.collection, mutation.recordId]))) throw new Error('record is being removed from the local sync cache')
      this.modeOf(mutation.collection)
      if (this.onDemandCollections.has(mutation.collection) && !this.projection.get(mutation.collection, mutation.recordId) && mutation.kind.type !== 'upsert') {
        throw new Error('load an on-demand record before editing it')
      }
    }
    const built = mutations.map(mutation => {
      const operation = this.kernel.buildOperation({
        key: { scope: this.scope, collection: mutation.collection, record_id: mutation.recordId },
        kind: mutation.kind,
      })
      return mutation.expectedVersion === undefined ? operation : {
        ...operation, metadata: { photon_context: { expectedVersion: mutation.expectedVersion } },
      }
    })
    const batch = atomic ? { id: newId('batch', this.clock()), operationIds: built.map(op => op.id) } : null
    const operations: Operation[] = built.map(op => batch ? {
      ...op, metadata: { ...(op.metadata as Record<string, unknown> ?? {}), photon_batch: batch },
    } : op)
    const staged = new Map<string, EngineRecord>()
    const projections = operations.map(operation => {
      const key = JSON.stringify([operation.key.collection, operation.key.record_id])
      const previous = staged.get(key) ?? this.toEngineRecord(operation.key.collection, operation.key.record_id)
      const projected = this.kernel.applyOperation(previous, operation)
      staged.set(key, projected)
      return { previous, projected }
    })
    const changes: RecordChange[] = []
    const durableOperations: Operation[] = []
    const durableMutations: Mutation[] = []
    const passthrough: { operation: Operation; previous: EngineRecord | null }[] = []
    let lastRecord: PhotonRecord<T> | null = null

    for (const [index, mutation] of mutations.entries()) {
      // A write can target a lazy collection before it hydrates. Kick the
      // hydration off so the stored base converges into the projection; the
      // optimistic record itself is shielded from the load by the
      // pending/durable guard in loadLazyCollection.
      if (this.onDemandCollections.has(mutation.collection) && !this.projection.get(mutation.collection, mutation.recordId) && mutation.kind.type !== 'upsert') {
        throw new Error('load an on-demand record with readPage() or liveRecord().ready() before editing')
      }
      if (this.lazyCollections.has(mutation.collection) && !this.onDemandCollections.has(mutation.collection)) {
        void this.hydrateCollection(mutation.collection)
      }
      const operation = operations[index]!

      const { previous: current, projected } = projections[index]!

      if (this.modeOf(mutation.collection) === 'passthrough') {
        // No durable log for passthrough: the write is pushed inline below,
        // and `previous` is what a rejection restores — there are no accepted
        // operations to replay it from.
        passthrough.push({ operation, previous: current })
      } else {
        durableOperations.push(operation)
        durableMutations.push(mutation)
      }
      this.registerPending(operation)
      this.appliedOperationIds.add(operation.id)

      const pendingChange = this.projection.addPending(mutation.collection, mutation.recordId)
      const setChange = this.projection.set(projected, { durable: false })
      if (pendingChange && !setChange) changes.push(pendingChange)
      if (setChange) changes.push(setChange)

      lastRecord = this.projection.get(mutation.collection, mutation.recordId) as PhotonRecord<T> | null
    }

    // Subscribers observe the mutation here, before this call returns.
    this.emit('local', changes)

    const persisted = durableOperations.length
      ? this.persistLocalOperations(durableOperations)
      : Promise.resolve()
    const local = persisted.then(() => {
      for (const operation of durableOperations) this.durableOperationIds.add(operation.id)
      if (durableOperations.length) this.sync.notifyLocalChange()
      const durableChanges: RecordChange[] = []
      for (const mutation of durableMutations) {
        const change = this.projection.markDurable(mutation.collection, mutation.recordId)
        if (change) durableChanges.push(change)
      }
      this.emit('local', durableChanges)
      const last = mutations[mutations.length - 1]!
      return this.projection.get(last.collection, last.recordId) as PhotonRecord<T> | null
    })

    this.localWrites.add(local)
    void local.then(() => this.localWrites.delete(local), () => this.localWrites.delete(local))
    const settled = Promise.all(
      operations.map(
        (operation) =>
          new Promise<AckResult>((resolve) => {
            const entry = this.pending.get(operation.id)
            if (entry) entry.resolve = resolve
            else resolve({ status: 'accepted', operationId: operation.id })
          }),
      ),
    ).then((results) => results.find((result) => result.status !== 'accepted') ?? results[0]!)

    if (passthrough.length) void this.pushPassthrough(passthrough)

    return {
      operationId: operations[0]!.id,
      optimistic: lastRecord,
      local,
      settled,
      rollback: () => this.rollbackOperations(operations),
    }
  }

  /**
   * The passthrough write path: straight to the REST resource, right now.
   *
   * There is deliberately no queue behind this. Passthrough is the zero-
   * backend-change mode, and its failure semantics are a plain REST app's: a
   * transport failure rejects the write and the optimistic value is undone.
   * Collections that should survive being offline belong on `rest-backed`.
   */
  private async pushPassthrough(
    batch: readonly { operation: Operation; previous: EngineRecord | null }[],
  ): Promise<void> {
    const transport = this.restTransport
    if (!transport) return

    const byOperationId = new Map(batch.map((entry) => [entry.operation.id, entry]))
    let decisions: readonly PushDecision[]
    try {
      const result = await transport.push({
        scope: this.scope,
        operations: batch.map((entry) => entry.operation),
      })
      decisions = result.decisions
    } catch (error) {
      decisions = batch.map((entry) => ({
        kind: 'rejected' as const,
        operationId: entry.operation.id,
        reason: error instanceof Error ? error.message : 'the server could not be reached',
      }))
    }

    for (const decision of decisions) {
      if (decision.kind === 'rejected') {
        this.resolvePassthroughRejection(decision, byOperationId.get(decision.operationId))
        continue
      }
      this.handleDecision(decision)
    }
  }

  /**
   * Undo a rejected passthrough write by restoring the value it displaced.
   * Rejected durable writes replay their accepted operations instead, but a
   * passthrough collection has no operation log to replay from.
   */
  private resolvePassthroughRejection(
    decision: Extract<PushDecision, { kind: 'rejected' }>,
    entry: { operation: Operation; previous: EngineRecord | null } | undefined,
  ): void {
    const pending = this.pending.get(decision.operationId)
    if (!pending || !entry) return
    this.pending.delete(decision.operationId)

    const { collection, record_id: recordId } = pending.operation.key
    const changes: RecordChange[] = []
    const released = this.projection.releasePending(collection, recordId)
    if (released) changes.push(released)

    if (entry.previous) {
      const change = this.projection.set(entry.previous, { durable: false })
      if (change) changes.push(change)
    } else {
      const change = this.projection.remove(collection, recordId)
      if (change) changes.push(change)
    }

    pending.resolve({
      status: 'rejected',
      operationId: decision.operationId,
      reason: decision.reason,
    })
    this.emit('rollback', changes)
  }

  upsert<T>(collection: Collection, recordId: RecordId, value: T, options?: MutationOptions): MutationHandle<T> {
    return this.mutate<T>({ ...options, collection, recordId, kind: { type: 'upsert', value } })
  }

  patch<T>(collection: Collection, recordId: RecordId, fields: Partial<T>, options?: MutationOptions): MutationHandle<T> {
    return this.mutate<T>({
      collection,
      recordId,
      kind: { type: 'patch', fields: fields as Record<string, unknown> },
      ...options,
    })
  }

  removeFields<T>(collection: Collection, recordId: RecordId, fields: string[]): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'remove_fields', fields } })
  }

  remove<T>(collection: Collection, recordId: RecordId): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'delete' } })
  }

  restore<T>(collection: Collection, recordId: RecordId, value?: T): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'restore', value } })
  }

  increment<T>(collection: Collection, recordId: RecordId, field: string, by: number): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'increment', field, by } })
  }

  setAdd<T>(collection: Collection, recordId: RecordId, field: string, values: unknown[]): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'set_add', field, values } })
  }

  setRemove<T>(collection: Collection, recordId: RecordId, field: string, values: unknown[]): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'set_remove', field, values } })
  }

  newId(prefix?: string): RecordId {
    return newId(prefix, this.clock())
  }

  // -------------------------------------------------------------------------
  // External data
  // -------------------------------------------------------------------------

  ingest<T>(
    collection: Collection,
    items: readonly { recordId: RecordId; value: T; deleted?: boolean }[],
    options?: { complete?: boolean },
  ): void {
    const changes: RecordChange[] = []
    const seen = new Set<RecordId>()

    for (const item of items) {
      seen.add(item.recordId)
      const key = { scope: this.scope, collection, record_id: item.recordId }
      const version = this.kernel.currentTimestamp()
      const engine: EngineRecord = {
        key,
        value: item.value,
        version,
        field_versions: {},
        deleted_at: item.deleted ? version : null,
        updated_by: 'ingest',
      }
      const change = this.projection.set(engine, { durable: false })
      if (change) changes.push(change)
    }

    // Only a complete listing can distinguish "deleted upstream" from
    // "not on this page", so tombstone reconciliation is gated on it.
    if (options?.complete) {
      for (const record of [...this.projection.recordsIn(collection)]) {
        if (!seen.has(record.key.record_id) && !record.pending) {
          const change = this.projection.remove(collection, record.key.record_id)
          if (change) changes.push(change)
        }
      }
    }

    this.emit('ingest', changes)
  }

  // -------------------------------------------------------------------------
  // Sync callbacks
  // -------------------------------------------------------------------------

  private handleDecision(decision: {
    kind: 'accepted' | 'rejected' | 'conflict'
    operationId: string
    reason?: string
    remoteValue?: unknown
    remoteSequence?: number
    aliasRecordId?: string
  }, reconciled = false): void {
    const entry = this.pending.get(decision.operationId)
    if (!entry) return

    const { collection, record_id: recordId } = entry.operation.key
    this.pending.delete(decision.operationId)

    const changes: RecordChange[] = []
    const released = this.projection.releasePending(collection, recordId)
    if (released) changes.push(released)

    switch (decision.kind) {
      case 'accepted': {
        // A REST backend that assigns its own id: move the record in one
        // ChangeSet so nothing ever observes both ids at once.
        if (decision.aliasRecordId && decision.aliasRecordId !== recordId) {
          const local = this.projection.get(collection, recordId)
          const removed = this.projection.remove(collection, recordId)
          if (removed) changes.push(removed)
          if (local) {
            const aliased: EngineRecord = {
              key: { scope: this.scope, collection, record_id: decision.aliasRecordId },
              value: local.value,
              version: local.version,
              field_versions: local.fieldVersions,
              deleted_at: local.deletedAt,
              updated_by: local.updatedBy,
            }
            const added = this.projection.set(aliased, { durable: true, aliasOf: recordId })
            if (added) changes.push(added)
          }
        }
        entry.resolve({ status: 'accepted', operationId: decision.operationId })
        if (this.selections) void this.pruneDeferred(collection, recordId).catch(error => console.error('Photon: deferred eviction failed', error))
        break
      }

      case 'rejected': {
        entry.resolve({
          status: 'rejected',
          operationId: decision.operationId,
          reason: decision.reason ?? 'rejected by server',
        })
        if (!reconciled) void this.reproject(collection, recordId, 'rollback')
        break
      }

      case 'conflict': {
        const conflict: Conflict = {
          id: `${decision.operationId}:conflict`,
          key: entry.operation.key,
          operationId: decision.operationId,
          reason: decision.reason ?? 'conflicting concurrent write',
          localValue: this.projection.get(collection, recordId)?.value ?? null,
          remoteValue: decision.remoteValue ?? null,
          createdAtMs: this.clock(),
        }
        this.conflictRows = [...this.conflictRows, conflict]
        if (!reconciled) void this.commit({ conflicts: [conflict] })
        entry.resolve({
          status: 'conflict',
          operationId: decision.operationId,
          conflictId: conflict.id,
        })
        break
      }
    }

    this.emit(decision.kind === 'rejected' ? 'rollback' : 'remote', changes)
  }

  /**
   * Re-derive a record from its accepted operations only.
   *
   * This is how a rejected write is undone. Restoring a remembered previous
   * value instead would erase any remote edit that landed while the write was
   * in flight.
   */
  private async reproject(
    collection: Collection,
    recordId: RecordId,
    origin: 'rollback' | 'remote',
  ): Promise<void> {
    const accepted = await this.storage.loadAcceptedOperations(this.scope, collection, recordId)
    const base = this.options.sync?.mode === 'scoped' ? await this.storage.getRecordBase?.(this.scope, collection, recordId) : null
    let rebuilt = base ? this.kernel.replay(base.record, accepted.filter(stored => stored.remoteSequence !== null && stored.remoteSequence > base.sequence).map(stored => stored.operation)) : this.kernel.replay(null, accepted.map(stored => stored.operation))
    for (const entry of this.pending.values()) {
      if (entry.operation.key.collection === collection && entry.operation.key.record_id === recordId) {
        rebuilt = this.kernel.applyOperation(rebuilt, entry.operation)
      }
    }

    const changes: RecordChange[] = []
    if (rebuilt) {
      const change = this.projection.set(rebuilt, { durable: true })
      if (change) changes.push(change)
    } else {
      const change = this.projection.remove(collection, recordId)
      if (change) changes.push(change)
    }
    this.emit(origin, changes)
  }

  /**
   * Fold a current-state listing into the projection.
   *
   * Pending local operations are re-applied on top afterwards, so a refetch
   * never wipes out an optimistic edit that has not been acknowledged yet.
   */
  private applySnapshot(page: Extract<PullResult, { kind: 'snapshot' }>): void {
    const changes: RecordChange[] = []
    const seen = new Set<RecordId>()

    // A complete server snapshot plus the re-applied pending operations below
    // is a superset of what stored-record hydration would load, so it counts
    // as hydration — and marking it now stops a slower loadRecords() from
    // resurrecting rows this snapshot deletes.
    if (page.complete && this.lazyCollections.has(page.collection)) {
      this.hydratedLazyCollections.add(page.collection)
    }

    for (const remote of page.records) {
      seen.add(remote.recordId)
      const version = this.kernel.currentTimestamp()
      const engine: EngineRecord = {
        key: { scope: this.scope, collection: remote.collection, record_id: remote.recordId },
        value: remote.value,
        version,
        field_versions: {},
        deleted_at: remote.deleted ? version : null,
        updated_by: 'remote',
      }
      const change = this.projection.set(engine, { durable: true })
      if (change) changes.push(change)
    }

    // Only a complete listing can tell "deleted upstream" from "not on this
    // page", so tombstone reconciliation is gated on the claim.
    if (page.complete) {
      for (const record of [...this.projection.recordsIn(page.collection)]) {
        if (!seen.has(record.key.record_id) && !record.pending) {
          const change = this.projection.remove(page.collection, record.key.record_id)
          if (change) changes.push(change)
        }
      }
    }

    // Re-apply unacknowledged local work over the server's view.
    for (const entry of this.pending.values()) {
      if (entry.operation.key.collection !== page.collection) continue
      const current = this.toEngineRecord(page.collection, entry.operation.key.record_id)
      const projected = this.kernel.applyOperation(current, entry.operation)
      const change = this.projection.set(projected, { durable: false })
      if (change) changes.push(change)
    }

    this.emit('remote', changes)
  }

  private async applyRemoteOperations(
    operations: readonly Operation[],
  ): Promise<readonly EngineRecord[]> {
    if (!operations.length) return []

    // Merging a remote operation needs the record's current state as its base.
    // For a lazy collection that base may still be in storage only, so pull
    // the collection in before applying — correctness outranks deferral.
    for (const operation of operations) {
      if (this.onDemandCollections.has(operation.key.collection)) await this.hydrateRecord(operation.key.collection, operation.key.record_id)
    }
    const needHydration = [
      ...new Set(operations.map((operation) => operation.key.collection)),
    ].filter(
      (collection) =>
        this.lazyCollections.has(collection) && !this.onDemandCollections.has(collection) && !this.hydratedLazyCollections.has(collection),
    )
    if (needHydration.length) {
      await Promise.all(needHydration.map((collection) => this.hydrateCollection(collection)))
    }

    const touched = new Map<string, EngineRecord>()
    for (const operation of operations) {
      const index = `${operation.key.collection}${operation.key.record_id}`
      if (!touched.has(index)) {
        const current = this.toEngineRecord(operation.key.collection, operation.key.record_id)
        if (current) touched.set(index, current)
      }
    }

    const result = this.kernel.applyRemoteBatch({
      operations,
      records: [...touched.values()],
      applied_operation_ids: [...this.appliedOperationIds],
    })

    for (const id of result.applied_operation_ids) this.appliedOperationIds.add(id)

    const changes: RecordChange[] = []
    for (const record of result.records) {
      const change = this.projection.set(record, { durable: true })
      if (change) changes.push(change)
    }
    this.emit('remote', changes)
    return result.records
  }

  subscribeSync(id: string, selector: RecordSelection): SyncSubscription {
    if (!this.selections) throw new Error('subscribeSync requires sync.mode = scoped')
    const handle = this.selections.open(id, selector)
    if (this.options.sync?.autoStart !== false) void this.sync.syncNow('manual')
    return handle
  }

  async readPage<T = unknown>(request: RecordPageRequest): Promise<LocalRecordPage<T>> {
    if (!this.storage.readRecordPage) throw new Error('store does not support paged reads')
    return this.enqueueWrite(async () => {
      const page = await this.storage.readRecordPage!(this.scope, request)
      const changes: RecordChange[] = []
      const data: PhotonRecord<T>[] = []
      for (const record of page.records) {
        this.kernel.observeTimestamp(record.version)
        const current = this.projection.get(record.key.collection, record.key.record_id)
        if (!current || (!current.pending && current.durable)) {
          const change = this.projection.set(record, { durable: true })
          if (change) changes.push(change)
        }
        this.touch(record.key.collection, record.key.record_id)
        data.push(this.projection.get(record.key.collection, record.key.record_id) as PhotonRecord<T>)
      }
      this.emit('hydrate', changes)
      this.trimCache()
      return { data, hasMore: page.hasMore, nextAfterId: page.nextAfterId }
    })
  }

  private async hydrateRecord(collection: Collection, recordId: RecordId): Promise<void> {
    await this.readPage({ collection, recordIds: [recordId], limit: 1 })
  }

  evictRecords(collection: Collection, recordIds: readonly RecordId[]): number {
    let count = 0
    for (const recordId of recordIds) {
      if (this.projection.get(collection, recordId)?.pending || this.collectionQueries.get(collection)?.size ||
          [...(this.recordQueries.get(collection) ?? [])].some(q => q.recordId === recordId)) continue
      if (this.projection.remove(collection, recordId)) {
        this.accessOrder.delete(JSON.stringify([collection, recordId]))
        count += 1
      }
    }
    return count
  }

  private touch(collection: Collection, recordId: RecordId): void {
    const key = JSON.stringify([collection, recordId])
    this.accessOrder.delete(key)
    this.accessOrder.set(key, { collection, recordId })
  }

  private trimCache(): void {
    const limit = this.options.cache?.maxRecords
    if (limit === undefined) return
    for (const { collection, recordId } of this.accessOrder.values()) {
      if (this.accessOrder.size <= limit) break
      if (this.onDemandCollections.has(collection)) this.evictRecords(collection, [recordId])
    }
  }

  private lockRemoval(key: string): void {
    this.removalInFlight.set(key, (this.removalInFlight.get(key) ?? 0) + 1)
  }

  private unlockRemoval(key: string): void {
    const remaining = (this.removalInFlight.get(key) ?? 1) - 1
    if (remaining) this.removalInFlight.set(key, remaining)
    else this.removalInFlight.delete(key)
  }

  private pruneDeferred(collection: Collection, recordId: RecordId): Promise<void> {
    const key = JSON.stringify([collection, recordId])
    let locked = false
    return this.enqueueWrite(async () => {
      if (!await this.storage.getDeferredEviction?.(this.scope, collection, recordId)) return
      this.lockRemoval(key)
      locked = true
      const members = await this.storage.getRecordMemberships!(this.scope, collection, recordId)
      if (members.length || [...this.pending.values()].some(entry => entry.operation.key.collection === collection && entry.operation.key.record_id === recordId)) return
      const target = { scope: this.scope, collection, recordId }
      await this.storage.commit({ deleteRecords: [target], deleteBases: [target], evictions: [{ ...target, deferred: false }] })
      const change = this.projection.remove(collection, recordId)
      if (change) this.emit('remote', [change])
    }).finally(() => { if (locked) this.unlockRemoval(key) })
  }

  private async releaseSelection(state: SelectionState): Promise<void> {
    let afterId: string | null = null
    for (;;) {
      const ids = await this.storage.getSelectionMembers!(this.scope, state.id, afterId, 200)
      if (!ids.length) break
      await this.applySelectionPage({ records: [], removals: ids.map(recordId => ({ recordId, reason: 'out_of_scope' })), cursor: state.cursor ?? { scope: this.scope, selector: state.selector, phase: 'delta', position: 0, afterId: null }, hasMore: false }, state)
      afterId = ids[ids.length - 1]!
    }
    await this.commit({ deleteSelectionStates: [{ scope: this.scope, id: state.id }] })
  }

  private async applySelectionPage(page: SelectionPullResult, state: SelectionState): Promise<void> {
    const keys = page.removals.map(removal => JSON.stringify([state.selector.collection, removal.recordId]))
    keys.forEach(key => this.lockRemoval(key))
    try { await this.enqueueWrite(() => this.commitSelectionPage(page, state)) }
    finally { keys.forEach(key => this.unlockRemoval(key)) }
  }

  private async commitSelectionPage(page: SelectionPullResult, state: SelectionState): Promise<void> {
    const collection = state.selector.collection
    const members: NonNullable<StoreWrite['memberships']>[number][] = []
    const records: EngineRecord[] = []
    const deleteRecords: NonNullable<StoreWrite['deleteRecords']>[number][] = []
    const deleteBases: NonNullable<StoreWrite['deleteBases']>[number][] = []
    const conflicts: Conflict[] = []
    const evictions: NonNullable<StoreWrite['evictions']>[number][] = []
    const statusUpdates: NonNullable<StoreWrite['statusUpdates']>[number][] = []
    const receipts = new Map((page.receipts ?? []).map(receipt => [receipt.operationId, receipt.remoteSequence]))
    const acceptedAfterBase = new Map<string, Operation[]>()
    for (const checkpoint of page.records) {
      const base = checkpoint.record
      this.kernel.observeTimestamp(base.version)
      evictions.push({ scope: this.scope, collection, recordId: base.key.record_id, deferred: false })
      const accepted = await this.storage.loadAcceptedOperations(this.scope, collection, base.key.record_id)
      const after = accepted.filter(op => op.remoteSequence !== null && op.remoteSequence > checkpoint.sequence).map(op => op.operation)
      acceptedAfterBase.set(base.key.record_id, after)
      members.push({ scope: this.scope, subscriptionId: state.id, collection, recordId: base.key.record_id })
      let projected = this.kernel.replay(base, after) ?? base
      for (const entry of this.pending.values()) {
        if (!this.durableOperationIds.has(entry.operation.id) || (receipts.get(entry.operation.id) ?? Infinity) <= checkpoint.sequence) continue
        if (entry.operation.key.collection === collection && entry.operation.key.record_id === base.key.record_id) {
          projected = this.kernel.applyOperation(projected, entry.operation)
        }
      }
      records.push(projected)
    }
    for (const removal of page.removals) {
      const target = { scope: this.scope, collection, recordId: removal.recordId }
      const memberships = await this.storage.getRecordMemberships!(this.scope, collection, removal.recordId)
      if (removal.reason === 'out_of_scope') {
        members.push({ ...target, subscriptionId: state.id, remove: true })
        if (memberships.some(id => id !== state.id)) continue
      } else {
        // Deletion/revocation invalidates every interest, not just this query.
        for (const id of memberships) members.push({ ...target, subscriptionId: id, remove: true })
      }
      const pending = [...this.pending.values()].filter(entry => !receipts.has(entry.operation.id) && entry.operation.key.collection === collection && entry.operation.key.record_id === removal.recordId)
      if (removal.reason === 'out_of_scope' && pending.length) { evictions.push({ ...target, deferred: true }); continue }
      const quarantine = new Map(pending.map(entry => [entry.operation.id, entry]))
      for (const entry of pending) {
        const batch = (entry.operation.metadata as { photon_batch?: { operationIds: string[] } } | undefined)?.photon_batch
        for (const id of batch?.operationIds ?? []) {
          const sibling = this.pending.get(id)
          if (sibling && !receipts.has(id)) quarantine.set(id, sibling)
        }
      }
      for (const entry of quarantine.values()) {
        const conflict: Conflict = {
          id: `${entry.operation.id}:conflict`, key: entry.operation.key, operationId: entry.operation.id,
          reason: removal.reason, localValue: this.projection.get(entry.operation.key.collection, entry.operation.key.record_id)?.value ?? null,
          remoteValue: null, createdAtMs: this.clock(),
        }
        conflicts.push(conflict)
        statusUpdates.push({ operationId: entry.operation.id, status: 'conflict' })
      }
      deleteRecords.push(target)
      deleteBases.push(target)
    }
    for (const [operationId, remoteSequence] of receipts) {
      if (this.pending.has(operationId)) statusUpdates.push({ operationId, status: 'accepted', remoteSequence })
    }
    await this.storage.commit({ evictions, records, bases: page.records, memberships: members, selectionStates: [state], deleteRecords, deleteBases, conflicts, statusUpdates })
    for (const conflict of conflicts) {
      const entry = this.pending.get(conflict.operationId)
      if (entry) {
        this.pending.delete(conflict.operationId)
        this.projection.releasePending(conflict.key.collection, conflict.key.record_id)
        entry.resolve({ status: 'conflict', operationId: conflict.operationId, conflictId: conflict.id })
      }
    }
    const known = new Set(this.conflictRows.map(row => row.id))
    this.conflictRows = [...this.conflictRows, ...conflicts.filter(row => !known.has(row.id))]
    const changes: RecordChange[] = []
    for (const record of records) {
      if (this.onDemandCollections.has(collection) && !this.projection.get(collection, record.key.record_id)) continue
      // A new mutation may have arrived while the durable commit was pending.
      const checkpoint = page.records.find(base => base.record.key.record_id === record.key.record_id)!
      let projected = this.kernel.replay(checkpoint.record, acceptedAfterBase.get(record.key.record_id) ?? []) ?? checkpoint.record
      for (const entry of this.pending.values()) {
        if ((receipts.get(entry.operation.id) ?? Infinity) <= checkpoint.sequence) continue
        if (entry.operation.key.collection === collection && entry.operation.key.record_id === record.key.record_id) projected = this.kernel.applyOperation(projected, entry.operation)
      }
      const change = this.projection.set(projected, { durable: true })
      if (change) changes.push(change)
    }
    for (const target of deleteRecords) {
      const change = this.projection.remove(collection, target.recordId)
      if (change) changes.push(change)
    }
    for (const [operationId, remoteSequence] of receipts) this.handleDecision({ kind: 'accepted', operationId, remoteSequence })
    this.emit('remote', changes)
    this.trimCache()
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  conflicts(collection?: Collection): readonly Conflict[] {
    if (!collection) return this.conflictRows
    return this.conflictRows.filter((conflict) => conflict.key.collection === collection)
  }

  async resolveConflict(conflictId: string, resolution: ConflictResolution): Promise<void> {
    const conflict = this.conflictRows.find((row) => row.id === conflictId)
    if (!conflict) return

    this.conflictRows = this.conflictRows.filter((row) => row.id !== conflictId)
    await this.commit({ resolveConflictIds: [conflictId] })

    const { collection, record_id: recordId } = conflict.key
    if (resolution.keep === 'local') {
      const local = this.projection.get(collection, recordId)
      this.upsert(collection, recordId, local?.value ?? conflict.localValue)
      return
    }
    if (resolution.keep === 'remote' && ['revoked', 'deleted'].includes(conflict.reason)) return
    const value = resolution.keep === 'remote' ? conflict.remoteValue : resolution.value
    this.upsert(collection, recordId, value)
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  subscribeChanges(listener: (changes: ChangeSet) => void): Unsubscribe {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  pendingCount(): number {
    return this.pending.size
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.sync.stop()
    this.selections?.close()
    await this.sync.drain()
    await this.selections?.drain()
    await this.writeTail
    this.unsubscribeStorage?.()
    this.unsubscribeStorage = null
    liveClients.delete(this.registryKey)
    await this.storage.close()
  }

  private registerPending(operation: Operation): void {
    this.pending.set(operation.id, { operation, resolve: () => {} })
  }

  private toEngineRecord(collection: Collection, recordId: RecordId): EngineRecord | null {
    const record = this.projection.get(collection, recordId)
    if (!record) return null
    return {
      key: record.key,
      value: record.value,
      version: record.version,
      field_versions: record.fieldVersions,
      deleted_at: record.deletedAt,
      updated_by: record.updatedBy,
    }
  }

  private enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const committed = this.writeTail.then(run)
    this.writeTail = committed.then(() => {}, () => {})
    return committed
  }

  private async storedRecord(collection: Collection, recordId: RecordId): Promise<EngineRecord | null> {
    if (this.storage.readRecordPage) {
      const page = await this.storage.readRecordPage(this.scope, { collection, recordIds: [recordId], includeDeleted: true, limit: 1 })
      return page.records[0] ?? null
    }
    // Compatibility for pre-extension stores. On-demand/scoped mode requires
    // bounded reads, so this fallback is never used for those collections.
    return (await this.storage.loadRecords(this.scope, { collection })).find(r => r.key.record_id === recordId) ?? null
  }

  private persistLocalOperations(operations: readonly Operation[]): Promise<void> {
    return this.enqueueWrite(async () => {
      const records = new Map<string, EngineRecord>()
      for (const operation of operations) {
        const key = JSON.stringify([operation.key.collection, operation.key.record_id])
        const previous = records.get(key) ?? await this.storedRecord(operation.key.collection, operation.key.record_id)
        records.set(key, this.kernel.applyOperation(previous, operation))
      }
      // Rebase on the last durable projection, not the optimistic snapshot
      // captured before an in-flight rejection or pull finished.
      await this.storage.commit({ operations, records: [...records.values()] })
    })
  }

  private commitDecisions(decisions: readonly PushDecision[], statusUpdates: NonNullable<StoreWrite['statusUpdates']>): Promise<void> {
    return this.enqueueWrite(async () => {
      const verdicts = new Map(decisions.map(decision => [decision.operationId, decision]))
      const targets = new Map<string, { collection: Collection; recordId: RecordId }>()
      for (const decision of decisions) {
        const entry = this.pending.get(decision.operationId)
        if (entry && decision.kind === 'rejected') {
          const target = { collection: entry.operation.key.collection, recordId: entry.operation.key.record_id }
          targets.set(JSON.stringify(target), target)
        }
      }
      const records: EngineRecord[] = []
      const deleteRecords: NonNullable<StoreWrite['deleteRecords']>[number][] = []
      for (const { collection, recordId } of targets.values()) {
        const accepted = await this.storage.loadAcceptedOperations(this.scope, collection, recordId)
        const base = this.selections ? await this.storage.getRecordBase!(this.scope, collection, recordId) : null
        let rebuilt = base ? this.kernel.replay(base.record, accepted.filter(op => op.remoteSequence !== null && op.remoteSequence > base.sequence).map(op => op.operation)) : this.kernel.replay(null, accepted.map(op => op.operation))
        for (const entry of this.pending.values()) {
          if (entry.operation.key.collection !== collection || entry.operation.key.record_id !== recordId ||
              !this.durableOperationIds.has(entry.operation.id) || verdicts.get(entry.operation.id)?.kind === 'rejected') continue
          rebuilt = this.kernel.applyOperation(rebuilt, entry.operation)
        }
        if (rebuilt) records.push(rebuilt)
        else deleteRecords.push({ scope: this.scope, collection, recordId })
      }
      const conflicts: Conflict[] = decisions.flatMap(decision => {
        const entry = this.pending.get(decision.operationId)
        return decision.kind === 'conflict' && entry ? [{
          id: `${decision.operationId}:conflict`, key: entry.operation.key,
          operationId: decision.operationId, reason: decision.reason,
          localValue: this.projection.get(entry.operation.key.collection, entry.operation.key.record_id)?.value ?? null,
          remoteValue: decision.remoteValue ?? null, createdAtMs: this.clock(),
        }] : []
      })
      // Status, conflict evidence and rollback projection survive a crash together.
      await this.storage.commit({ statusUpdates, records, deleteRecords, conflicts })
      for (const decision of decisions) this.handleDecision(decision, true)
      const changes: RecordChange[] = []
      for (const target of targets.values()) {
        let projected = records.find(r => r.key.collection === target.collection && r.key.record_id === target.recordId) ?? null
        for (const entry of this.pending.values()) {
          if (entry.operation.key.collection === target.collection && entry.operation.key.record_id === target.recordId && !this.durableOperationIds.has(entry.operation.id)) {
            projected = this.kernel.applyOperation(projected, entry.operation)
          }
        }
        const change = projected ? this.projection.set(projected, { durable: true }) : this.projection.remove(target.collection, target.recordId)
        if (change) changes.push(change)
      }
      this.emit('rollback', changes)
    })
  }

  private async commit(write: StoreWrite): Promise<void> {
    try {
      await this.enqueueWrite(() => this.storage.commit(write))
    } catch (error) {
      // A failed durable write must not silently look like a success: the
      // record stays `durable: false` so the UI can tell.
      console.error('Photon: durable write failed', error)
      throw error
    }
  }

  private async rollbackOperations(operations: readonly Operation[]): Promise<void> {
    for (const operation of operations) {
      this.pending.delete(operation.id)
      this.projection.releasePending(operation.key.collection, operation.key.record_id)
      await this.reproject(operation.key.collection, operation.key.record_id, 'rollback')
    }
  }

  /**
   * Emit synchronously, then coalesce query notification into a microtask.
   *
   * A microtask rather than `requestAnimationFrame`: rAF costs a frame of input
   * latency and does not exist in Node, workers, or Vitest.
   */
  private emit(origin: ChangeSet['origin'], changes: readonly RecordChange[]): void {
    if (!changes.length) return

    const collections = [...new Set(changes.map((change) => change.collection))]
    const changeSet: ChangeSet = { origin, changes, collections }

    for (const listener of this.changeListeners) listener(changeSet)
    this.options.onChange?.(changeSet)

    for (const collection of collections) this.dirtyCollections.add(collection)
    this.scheduleNotify()
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    queueMicrotask(() => {
      this.notifyScheduled = false
      const collections = this.dirtyCollections
      this.dirtyCollections = new Set()
      this.isHydrated = true

      for (const collection of collections) {
        // A change can land in a lazy collection mid-hydration (an optimistic
        // write, a pulled operation). Data updates, but the contract is that
        // the status stays `loading` until hydration completes.
        const status = this.collectionStatus(collection)
        for (const query of this.collectionQueries.get(collection) ?? []) {
          if (query.invalidate(status)) query.notify()
        }
        for (const query of this.recordQueries.get(collection) ?? []) {
          if (query.invalidate(status)) query.notify()
        }
      }
    })
  }
}

/**
 * Strict HLC ordering for hydration merges. Ties are not "newer": applying a
 * stored row over an identical in-memory record would be pure churn.
 */
function isNewerVersion(candidate: HybridTimestamp, current: HybridTimestamp): boolean {
  if (candidate.wall_time_ms !== current.wall_time_ms) {
    return candidate.wall_time_ms > current.wall_time_ms
  }
  if (candidate.counter !== current.counter) return candidate.counter > current.counter
  return candidate.actor_id > current.actor_id
}

export type { QueryDescriptor, QueryState, LiveQuery }
