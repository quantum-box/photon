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
import type { LiveQuery, QueryDescriptor, QueryState } from './query.js'
import type { LocalStore, StoreWrite } from './store.js'
import { SyncEngine } from './sync/controller.js'
import type { SyncController, SyncTransport } from './sync/types.js'
import type {
  AckResult,
  ChangeSet,
  Collection,
  Conflict,
  ConflictResolution,
  EngineRecord,
  Mutation,
  MutationHandle,
  Operation,
  PhotonRecord,
  RecordChange,
  RecordId,
  Scope,
  Unsubscribe,
} from './types.js'

export type CollectionMode = 'engine-native' | 'rest-backed' | 'passthrough'

export interface CollectionConfig {
  readonly mode: CollectionMode
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
  readonly sync?: {
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

export interface PhotonClient {
  readonly scope: Scope
  readonly actorId: string
  readonly storage: LocalStore
  readonly sync: SyncController

  query<T = unknown>(descriptor: QueryDescriptor<T>): LiveQuery<PhotonRecord<T>[]>
  liveRecord<T = unknown>(collection: Collection, recordId: RecordId): LiveQuery<PhotonRecord<T> | null>

  mutate<T = unknown>(mutation: Mutation): MutationHandle<T>
  /** One ChangeSet, one durable transaction, one push batch. */
  transact(mutations: readonly Mutation[]): MutationHandle<void>

  upsert<T = unknown>(collection: Collection, recordId: RecordId, value: T): MutationHandle<T>
  /** Pass only the fields that changed: per-field merge depends on it. */
  patch<T = unknown>(collection: Collection, recordId: RecordId, fields: Partial<T>): MutationHandle<T>
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
  private readonly registryKey: string

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

    this.sync = new SyncEngine({
      scope: options.scope,
      ...(options.transport ? { transport: options.transport } : {}),
      store: options.storage,
      clock,
      remoteId: options.sync?.remoteId ?? 'photon-server',
      pushDebounceMs: options.sync?.pushDebounceMs ?? 150,
      pollIntervalMs: options.sync?.pollIntervalMs ?? 30_000,
      pullPageSize: options.sync?.pullPageSize ?? 200,
      collectPending: () => [...this.pending.values()].map((entry) => entry.operation),
      onDecision: (decision) => this.handleDecision(decision),
      applyRemote: (operations) => this.applyRemoteOperations(operations),
      knownOperationIds: () => this.appliedOperationIds,
      pendingCount: () => this.pending.size,
      conflictCount: () => this.conflictRows.length,
    })
  }

  async bootstrap(): Promise<void> {
    await this.storage.migrate()

    const [records, pendingOps, operationIds, conflicts] = await Promise.all([
      this.storage.loadRecords(this.scope),
      this.storage.loadPendingOperations(this.scope),
      this.storage.loadOperationIds(this.scope),
      this.storage.loadConflicts(this.scope),
    ])

    for (const id of operationIds) this.appliedOperationIds.add(id)
    this.conflictRows = conflicts

    const changes: RecordChange[] = []
    for (const record of records) {
      const change = this.projection.set(record, { durable: true })
      if (change) changes.push(change)
    }

    // Pending operations were durably stored but never acknowledged. Their
    // effects are already in the projection; re-registering them is what keeps
    // `pending` true across a reload and gets them re-pushed.
    for (const stored of pendingOps) {
      this.registerPending(stored.operation)
      const change = this.projection.addPending(
        stored.operation.key.collection,
        stored.operation.key.record_id,
      )
      if (change) changes.push(change)
    }

    this.hydrateResolve()
    this.emit('hydrate', changes)

    if (this.options.sync?.autoStart !== false) this.sync.start()
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  query<T = unknown>(descriptor: QueryDescriptor<T>): LiveQuery<PhotonRecord<T>[]> {
    const query = new CollectionQuery<T>(
      descriptor,
      {
        recordsIn: (collection) => this.projection.recordsIn(collection) as Iterable<PhotonRecord<T>>,
        hydrated: this.hydrated,
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

    query.invalidate(this.isHydrated ? 'ready' : 'loading')
    void this.hydrated.then(() => {
      if (query.invalidate('ready')) query.notify()
    })

    return query
  }

  liveRecord<T = unknown>(
    collection: Collection,
    recordId: RecordId,
  ): LiveQuery<PhotonRecord<T> | null> {
    const query = new RecordQuery<T>(
      collection,
      recordId,
      (c, id) => this.projection.get(c, id) as PhotonRecord<T> | null,
      this.hydrated,
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

    query.invalidate(this.isHydrated ? 'ready' : 'loading')
    void this.hydrated.then(() => {
      if (query.invalidate('ready')) query.notify()
    })

    return query
  }

  private isHydrated = false

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  mutate<T = unknown>(mutation: Mutation): MutationHandle<T> {
    return this.applyMutations<T>([mutation])
  }

  transact(mutations: readonly Mutation[]): MutationHandle<void> {
    return this.applyMutations<void>(mutations)
  }

  private applyMutations<T>(mutations: readonly Mutation[]): MutationHandle<T> {
    if (this.closed) throw new Error('Photon client is closed')
    if (!mutations.length) throw new Error('transact() requires at least one mutation')

    const operations: Operation[] = []
    const changes: RecordChange[] = []
    const engineRecords: EngineRecord[] = []
    let lastRecord: PhotonRecord<T> | null = null

    for (const mutation of mutations) {
      const operation = this.kernel.buildOperation({
        key: {
          scope: this.scope,
          collection: mutation.collection,
          record_id: mutation.recordId,
        },
        kind: mutation.kind,
      })

      const current = this.toEngineRecord(mutation.collection, mutation.recordId)
      const projected = this.kernel.applyOperation(current, operation)

      operations.push(operation)
      engineRecords.push(projected)
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

    const local = this.commit({ operations, records: engineRecords })
      .then(() => {
        const durableChanges: RecordChange[] = []
        for (const mutation of mutations) {
          const change = this.projection.markDurable(mutation.collection, mutation.recordId)
          if (change) durableChanges.push(change)
        }
        this.emit('local', durableChanges)
        const last = mutations[mutations.length - 1]!
        return this.projection.get(last.collection, last.recordId) as PhotonRecord<T> | null
      })

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

    void this.sync.notifyLocalChange()

    return {
      operationId: operations[0]!.id,
      optimistic: lastRecord,
      local,
      settled,
      rollback: () => this.rollbackOperations(operations),
    }
  }

  upsert<T>(collection: Collection, recordId: RecordId, value: T): MutationHandle<T> {
    return this.mutate<T>({ collection, recordId, kind: { type: 'upsert', value } })
  }

  patch<T>(collection: Collection, recordId: RecordId, fields: Partial<T>): MutationHandle<T> {
    return this.mutate<T>({
      collection,
      recordId,
      kind: { type: 'patch', fields: fields as Record<string, unknown> },
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
  }): void {
    const entry = this.pending.get(decision.operationId)
    if (!entry) return

    const { collection, record_id: recordId } = entry.operation.key
    this.pending.delete(decision.operationId)

    const changes: RecordChange[] = []
    const released = this.projection.releasePending(collection, recordId)
    if (released) changes.push(released)

    switch (decision.kind) {
      case 'accepted':
        entry.resolve({ status: 'accepted', operationId: decision.operationId })
        break

      case 'rejected': {
        entry.resolve({
          status: 'rejected',
          operationId: decision.operationId,
          reason: decision.reason ?? 'rejected by server',
        })
        void this.reproject(collection, recordId, 'rollback')
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
        void this.commit({ conflicts: [conflict] })
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
    const rebuilt = this.kernel.replay(
      null,
      accepted.map((stored) => stored.operation),
    )

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

  private applyRemoteOperations(operations: readonly Operation[]): void {
    if (!operations.length) return

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
      if (local) this.upsert(collection, recordId, local.value)
      return
    }
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

  private async commit(write: StoreWrite): Promise<void> {
    try {
      await this.storage.commit(write)
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
        for (const query of this.collectionQueries.get(collection) ?? []) {
          if (query.invalidate('ready')) query.notify()
        }
        for (const query of this.recordQueries.get(collection) ?? []) {
          if (query.invalidate('ready')) query.notify()
        }
      }
    })
  }
}

export type { QueryDescriptor, QueryState, LiveQuery }
