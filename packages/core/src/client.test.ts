import type { SelectionState, RecordCheckpoint } from './selection.js'
/**
 * Client behaviour that the whole design rests on.
 *
 * Uses a fake kernel and an in-memory store so these stay fast and
 * deterministic; the real kernel is covered by the playground's integration
 * test and by the Rust suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPhotonClient, type PhotonClient, type PhotonClientOptions } from './client.js'
import type { PhotonKernelModule } from './kernel.js'
import type { CursorRow, LoadRecordsOptions, LocalStore, StoreWrite } from './store.js'
import type { SyncTransport } from './sync/types.js'
import type { Conflict, EngineRecord, Operation, StoredOperation } from './types.js'

// --- a kernel that implements just enough real semantics -------------------

function fakeKernelModule(): PhotonKernelModule {
  const PhotonKernel = class {
    private counter = 0
    constructor(
      private readonly actor: string,
      private wall: number,
    ) {}

    actorId() {
      return this.actor
    }

    private stamp(nowMs: number) {
      if (nowMs > this.wall) {
        this.wall = nowMs
        this.counter = 0
      } else {
        this.counter += 1
      }
      return { wall_time_ms: this.wall, counter: this.counter, actor_id: this.actor }
    }

    buildOperation(intentJson: string, nowMs: number) {
      const intent = JSON.parse(intentJson)
      return JSON.stringify({
        id: intent.operation_id ?? `op-${this.wall}-${this.counter}-${Math.random()}`,
        key: intent.key,
        actor_id: this.actor,
        timestamp: this.stamp(nowMs),
        kind: intent.kind,
      })
    }

    applyOperation(currentJson: string | null | undefined, operationJson: string) {
      const operation: Operation = JSON.parse(operationJson)
      const current: EngineRecord | null = currentJson ? JSON.parse(currentJson) : null
      return JSON.stringify(project(current, operation))
    }

    replay(currentJson: string | null | undefined, operationsJson: string) {
      let record: EngineRecord | null = currentJson ? JSON.parse(currentJson) : null
      for (const operation of JSON.parse(operationsJson) as Operation[]) {
        record = project(record, operation)
      }
      return JSON.stringify({ record })
    }

    applyRemoteBatch(batchJson: string) {
      const batch = JSON.parse(batchJson)
      const already = new Set<string>(batch.applied_operation_ids)
      const records = new Map<string, EngineRecord>(
        batch.records.map((r: EngineRecord) => [index(r.key), r]),
      )
      const applied: string[] = []
      const skipped: string[] = []
      for (const operation of batch.operations as Operation[]) {
        if (already.has(operation.id)) {
          skipped.push(operation.id)
          continue
        }
        records.set(index(operation.key), project(records.get(index(operation.key)) ?? null, operation))
        applied.push(operation.id)
      }
      return JSON.stringify({
        records: [...records.values()],
        applied_operation_ids: applied,
        skipped_operation_ids: skipped,
      })
    }

    observeTimestamp() {}

    currentTimestamp() {
      return JSON.stringify({ wall_time_ms: this.wall, counter: this.counter, actor_id: this.actor })
    }
  }
  return { PhotonKernel } as unknown as PhotonKernelModule
}

function index(key: EngineRecord['key']) {
  return `${key.scope}/${key.collection}/${key.record_id}`
}

function project(current: EngineRecord | null, operation: Operation): EngineRecord {
  const base = current?.value && typeof current.value === 'object' ? { ...(current.value as object) } : {}
  let value: unknown = base
  let deletedAt = current?.deleted_at ?? null

  switch (operation.kind.type) {
    case 'upsert':
      value = operation.kind.value
      deletedAt = null
      break
    case 'patch':
      value = { ...base, ...operation.kind.fields }
      break
    case 'increment':
      value = { ...base, [operation.kind.field]: Number(base[operation.kind.field] ?? 0) + operation.kind.by }
      break
    case 'delete':
      deletedAt = operation.timestamp
      break
    case 'restore':
      deletedAt = null
      if (operation.kind.value !== undefined) value = operation.kind.value
      break
    default:
      break
  }

  return {
    key: operation.key,
    value,
    version: operation.timestamp,
    field_versions: {},
    deleted_at: deletedAt,
    updated_by: operation.actor_id,
  }
}

// --- an in-memory store ----------------------------------------------------

function memoryStore(): LocalStore & {
  writes: StoreWrite[]
  loadRecordsCalls: { options: LoadRecordsOptions | undefined; served: number }[]
  seedRecord(record: EngineRecord): void
  seedPendingOperation(operation: Operation): void
} {
  const records = new Map<string, EngineRecord>()
  const operations = new Map<string, StoredOperation>()
  const conflicts: Conflict[] = []
  const cursors = new Map<string, CursorRow>()
  const selections = new Map<string, SelectionState>()
  const memberships = new Map<string, Set<string>>()
  const bases = new Map<string, RecordCheckpoint>()
  const evictions = new Set<string>()
  let sequence = 0
  const writes: StoreWrite[] = []
  const loadRecordsCalls: { options: LoadRecordsOptions | undefined; served: number }[] = []

  return {
    writes,
    loadRecordsCalls,
    seedRecord(record) {
      records.set(index(record.key), record)
    },
    seedPendingOperation(operation) {
      sequence += 1
      operations.set(operation.id, {
        operation,
        status: 'pending',
        localSequence: sequence,
        remoteSequence: null,
        receivedAtMs: 0,
      })
    },
    async migrate() {},
    async loadRecords(_scope, options) {
      const rows = [...records.values()].filter((record) => {
        if (options?.collection !== undefined) {
          return record.key.collection === options.collection
        }
        if (options?.excludeCollections?.length) {
          return !options.excludeCollections.includes(record.key.collection)
        }
        return true
      })
      loadRecordsCalls.push({ options, served: rows.length })
      return rows
    },
    async readRecordPage(scope, request) {
      const found = [...records.values()].filter(r => r.key.scope === scope && r.key.collection === request.collection && (request.includeDeleted || !r.deleted_at) && (!request.recordIds || request.recordIds.includes(r.key.record_id)) && (!request.afterId || r.key.record_id > request.afterId)).sort((a,b) => a.key.record_id.localeCompare(b.key.record_id))
      const page = found.slice(0, request.limit)
      return { records: page, hasMore: found.length > request.limit, nextAfterId: found.length > request.limit ? page.at(-1)!.key.record_id : null }
    },
    async getSelectionMembers(scope, id, afterId, limit) { return [...memberships.entries()].filter(([key, ids]) => key.startsWith(`${scope}/`) && ids.has(id)).map(([key]) => key.split('/').at(-1)!).filter(key => afterId === null || key > afterId).sort().slice(0,limit) },
    async getSelectionState(scope, id) { return selections.get(`${scope}/${id}`) ?? null },
    async getRecordMemberships(scope, collection, recordId) { return [...(memberships.get(`${scope}/${collection}/${recordId}`) ?? [])] },
    async getRecordBase(scope, collection, recordId) { return bases.get(`${scope}/${collection}/${recordId}`) ?? null },
    async getDeferredEviction(scope, collection, recordId) { return evictions.has(`${scope}/${collection}/${recordId}`) },
    async loadPendingOperations() {
      return [...operations.values()].filter((o) => o.status === 'pending')
    },
    async loadAcceptedOperations(_scope, collection, recordId) {
      return [...operations.values()]
        .filter(
          (o) =>
            o.status === 'accepted' &&
            o.operation.key.collection === collection &&
            o.operation.key.record_id === recordId,
        )
        .sort((a, b) => a.localSequence - b.localSequence)
    },
    async loadOperationIds() {
      return [...operations.keys()]
    },
    async loadConflicts() {
      return conflicts
    },
    async getCursor(scope, remote) {
      return cursors.get(`${scope}/${remote}`) ?? null
    },
    async commit(write) {
      writes.push(write)
      for (const target of write.deleteSelectionStates ?? []) selections.delete(`${target.scope}/${target.id}`)
      for (const state of write.selectionStates ?? []) selections.set(`${state.scope}/${state.id}`, structuredClone(state))
      for (const member of write.memberships ?? []) {
        const key = `${member.scope}/${member.collection}/${member.recordId}`
        const ids = memberships.get(key) ?? new Set<string>()
        if (member.remove) ids.delete(member.subscriptionId)
        else ids.add(member.subscriptionId)
        memberships.set(key, ids)
      }
      for (const base of write.bases ?? []) bases.set(index(base.record.key), base)
      for (const target of write.deleteRecords ?? []) records.delete(`${target.scope}/${target.collection}/${target.recordId}`)
      for (const target of write.deleteBases ?? []) bases.delete(`${target.scope}/${target.collection}/${target.recordId}`)
      for (const target of write.evictions ?? []) {
        const key = `${target.scope}/${target.collection}/${target.recordId}`
        if (target.deferred) evictions.add(key); else evictions.delete(key)
      }
      for (const operation of write.operations ?? []) {
        if (operations.has(operation.id)) continue
        sequence += 1
        operations.set(operation.id, {
          operation,
          status: 'pending',
          localSequence: sequence,
          remoteSequence: null,
          receivedAtMs: 0,
        })
      }
      for (const record of write.records ?? []) records.set(index(record.key), record)
      for (const update of write.statusUpdates ?? []) {
        const existing = operations.get(update.operationId)
        if (existing) operations.set(update.operationId, { ...existing, status: update.status, remoteSequence: update.remoteSequence ?? existing.remoteSequence })
      }
      for (const conflict of write.conflicts ?? []) conflicts.push(conflict)
      if (write.cursor) cursors.set(`${write.cursor.scope}/${write.cursor.remote}`, write.cursor)
    },
    async stats() {
      return { operations: { pending: 0, accepted: 0, rejected: 0, conflict: 0 }, recordsByCollection: {} }
    },
    raw() {
      return { dataDir: `memory-${Math.random()}` }
    },
    async close() {},
  }
}

async function makeClient(
  overrides: Partial<
    Pick<
      PhotonClientOptions,
      'storage' | 'transport' | 'sync' | 'collections' | 'resolveCollection' | 'cache'
    >
  > = {},
): Promise<PhotonClient> {
  let now = 1_700_000_000_000
  return createPhotonClient({
    scope: 'workspace:test',
    actorId: 'actor-1',
    storage: memoryStore(),
    kernel: fakeKernelModule(),
    clock: () => (now += 1),
    ...overrides,
  })
}

describe('mutations', () => {
  let client: PhotonClient

  beforeEach(async () => {
    client = await makeClient()
  })

  it('exposes the optimistic record synchronously', () => {
    const handle = client.upsert('records', 'r1', { title: 'now' })
    // No await: this is the property the whole engine exists to provide.
    expect(handle.optimistic?.value).toEqual({ title: 'now' })
    expect(handle.optimistic?.pending).toBe(true)
    expect(handle.optimistic?.durable).toBe(false)
  })

  it('emits a ChangeSet before the call returns', () => {
    const seen: string[] = []
    client.subscribeChanges((set) => seen.push(set.origin))
    client.upsert('records', 'r1', { title: 'now' })
    expect(seen).toEqual(['local'])
  })

  it('marks the record durable once storage has it', async () => {
    const handle = client.upsert('records', 'r1', { title: 'now' })
    expect(handle.optimistic?.durable).toBe(false)
    const durable = await handle.local
    expect(durable?.durable).toBe(true)
  })

  it('merges a patch onto the existing value', async () => {
    await client.upsert('records', 'r1', { title: 'a', status: 'todo' }).local
    const patched = await client.patch('records', 'r1', { status: 'done' }).local
    expect(patched?.value).toEqual({ title: 'a', status: 'done' })
  })

  it('generates ids that do not collide', () => {
    const ids = new Set(Array.from({ length: 500 }, () => client.newId('rec')))
    expect(ids.size).toBe(500)
  })
})

describe('queries', () => {
  it('serves reads synchronously from the projection', async () => {
    const client = await makeClient()
    const query = client.query({ collection: 'records' })
    await query.ready()

    client.upsert('records', 'r1', { status: 'todo' })
    await Promise.resolve()
    await Promise.resolve()

    expect(query.getSnapshot().data).toHaveLength(1)
    query.destroy()
  })

  it('returns a stable snapshot identity until listeners are notified', async () => {
    // useSyncExternalStore loops forever if this is violated.
    const client = await makeClient()
    const query = client.query({ collection: 'records' })
    await query.ready()
    expect(query.getSnapshot()).toBe(query.getSnapshot())
  })

  it('keeps record identity stable for rows that did not change', async () => {
    const client = await makeClient()
    await client.upsert('records', 'r1', { n: 1 }).local
    await client.upsert('records', 'r2', { n: 2 }).local

    const query = client.query<{ n: number }>({ collection: 'records', orderBy: [{ field: 'n' }] })
    await query.ready()
    await tick()
    const before = query.getSnapshot().data
    expect(before).toHaveLength(2)

    client.patch('records', 'r2', { n: 3 })
    await tick()
    const after = query.getSnapshot().data

    // r1 is the same object; only r2 was reallocated. This is what stops a
    // single edit from re-rendering every memoized row.
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    query.destroy()
  })

  it('applies the where DSL and excludes deleted records', async () => {
    const client = await makeClient()
    await client.upsert('records', 'r1', { status: 'todo' }).local
    await client.upsert('records', 'r2', { status: 'done' }).local

    const query = client.query({ collection: 'records', where: { status: 'todo' } })
    await query.ready()
    await tick()
    expect(query.getSnapshot().data).toHaveLength(1)

    client.remove('records', 'r1')
    await tick()
    expect(query.getSnapshot().data).toHaveLength(0)
    query.destroy()
  })

  it('emits one ChangeSet for a whole transaction', async () => {
    const client = await makeClient()
    const query = client.query({ collection: 'records' })
    await query.ready()
    await tick()

    const sets: number[] = []
    client.subscribeChanges((set) => sets.push(set.changes.length))

    client.transact([
      { collection: 'records', recordId: 'a', kind: { type: 'upsert', value: { n: 1 } } },
      { collection: 'records', recordId: 'b', kind: { type: 'upsert', value: { n: 2 } } },
    ])

    // Both records land in a single ChangeSet, synchronously. The later
    // durable-flag flip is a separate, real state change.
    expect(sets[0]).toBe(2)

    await tick()
    expect(query.getSnapshot().data).toHaveLength(2)
    query.destroy()
  })

  it('does not wake queries on other collections', async () => {
    const client = await makeClient()
    const records = client.query({ collection: 'records' })
    const docs = client.query({ collection: 'docs' })
    await records.ready()
    await tick()

    const listener = vi.fn()
    docs.subscribe(listener)
    client.upsert('records', 'r1', { n: 1 })
    await tick()

    expect(listener).not.toHaveBeenCalled()
    records.destroy()
    docs.destroy()
  })
})

describe('ingest', () => {
  it('accepts externally fetched data without writing operations', async () => {
    const client = await makeClient()
    client.ingest('issues', [{ recordId: 'i1', value: { title: 'from REST' } }])
    await tick()

    const query = client.query({ collection: 'issues' })
    await query.ready()
    await tick()
    expect(query.getSnapshot().data[0]?.value).toEqual({ title: 'from REST' })
    expect(client.pendingCount()).toBe(0)
    query.destroy()
  })

  it('only reconciles tombstones when the listing claims to be complete', async () => {
    const client = await makeClient()
    client.ingest('issues', [
      { recordId: 'i1', value: { n: 1 } },
      { recordId: 'i2', value: { n: 2 } },
    ])
    await tick()

    // A page, not the whole collection: i2 must survive.
    client.ingest('issues', [{ recordId: 'i1', value: { n: 1 } }])
    await tick()
    const query = client.query({ collection: 'issues' })
    await query.ready()
    await tick()
    expect(query.getSnapshot().data).toHaveLength(2)

    // Now the caller asserts completeness, so i2 really is gone upstream.
    client.ingest('issues', [{ recordId: 'i1', value: { n: 1 } }], { complete: true })
    await tick()
    expect(query.getSnapshot().data).toHaveLength(1)
    query.destroy()
  })
})

describe('lazy hydration', () => {
  const scope = 'workspace:test'

  function engineRecord(
    collection: string,
    recordId: string,
    value: unknown,
    wallTimeMs = 1,
  ): EngineRecord {
    return {
      key: { scope, collection, record_id: recordId },
      value,
      version: { wall_time_ms: wallTimeMs, counter: 0, actor_id: 'seed' },
      field_versions: {},
      deleted_at: null,
      updated_by: 'seed',
    }
  }

  function lazyClient(store: LocalStore): Promise<PhotonClient> {
    let now = 1_700_000_000_000
    return createPhotonClient({
      scope,
      actorId: 'actor-1',
      storage: store,
      kernel: fakeKernelModule(),
      clock: () => (now += 1),
      collections: { records: { mode: 'engine-native', hydration: 'lazy' } },
    })
  }

  it('bootstraps from structure only, independent of lazy record count', async () => {
    const store = memoryStore()
    store.seedRecord(engineRecord('databases', 'db1', { name: 'Roadmap' }))
    for (let i = 0; i < 500; i += 1) {
      store.seedRecord(engineRecord('records', `r${i}`, { n: i }))
    }

    const client = await lazyClient(store)

    // One structural row crossed the storage boundary at startup; the 500
    // lazy records did not. That is the whole point of this feature.
    expect(store.loadRecordsCalls).toEqual([
      { options: { excludeCollections: ['records'] }, served: 1 },
    ])

    const structure = client.query({ collection: 'databases' })
    await structure.ready()
    await tick()
    expect(structure.getSnapshot().status).toBe('ready')
    expect(structure.getSnapshot().data).toHaveLength(1)
    structure.destroy()
  })

  it('keeps a lazy query loading until hydration completes, then serves stored data', async () => {
    const store = memoryStore()
    store.seedRecord(engineRecord('records', 'r1', { title: 'stored' }))
    const client = await lazyClient(store)

    const query = client.query({ collection: 'records' })
    expect(query.getSnapshot().status).toBe('loading')
    expect(query.getSnapshot().data).toHaveLength(0)

    await query.ready()
    await tick()
    expect(query.getSnapshot().status).toBe('ready')
    expect(query.getSnapshot().data[0]?.value).toEqual({ title: 'stored' })
    query.destroy()
  })

  it('hydrates explicitly through hydrateCollection() without a query', async () => {
    const store = memoryStore()
    store.seedRecord(engineRecord('records', 'r1', { title: 'stored' }))
    const client = await lazyClient(store)

    await client.hydrateCollection('records')

    const query = client.query({ collection: 'records' })
    expect(query.getSnapshot().status).toBe('ready')
    expect(query.getSnapshot().data).toHaveLength(1)
    // Loaded exactly once: the query did not trigger a second load.
    expect(store.loadRecordsCalls.filter((call) => call.options?.collection === 'records')).toHaveLength(1)
    query.destroy()
  })

  it('restores pending operations for lazy collections at bootstrap', async () => {
    const store = memoryStore()
    const operation: Operation = {
      id: 'op-offline-1',
      key: { scope, collection: 'records', record_id: 'r1' },
      actor_id: 'actor-1',
      timestamp: { wall_time_ms: 5, counter: 0, actor_id: 'actor-1' },
      kind: { type: 'upsert', value: { title: 'offline write' } },
    }
    store.seedPendingOperation(operation)
    // The row the operation's own durable commit wrote before the reload.
    store.seedRecord(engineRecord('records', 'r1', { title: 'offline write' }, 5))

    const client = await lazyClient(store)

    // The unpushed write is queued for push even though its collection has
    // not hydrated yet — laziness must never lose an offline operation.
    expect(client.pendingCount()).toBe(1)

    await client.hydrateCollection('records')
    await tick()
    const query = client.query({ collection: 'records' })
    const row = query.getSnapshot().data[0]
    expect(row?.value).toEqual({ title: 'offline write' })
    expect(row?.pending).toBe(true)
    query.destroy()
  })

  it('does not clobber an optimistic write that raced ahead of hydration', async () => {
    const store = memoryStore()
    store.seedRecord(engineRecord('records', 'r1', { title: 'stale stored' }))

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Snapshot the rows first, then hold them until released: the load
    // resolves with genuinely stale data from before the optimistic write.
    const loadRecords = store.loadRecords.bind(store)
    store.loadRecords = async (loadScope, options) => {
      const rows = await loadRecords(loadScope, options)
      if (options?.collection === 'records') await gate
      return rows
    }

    const client = await lazyClient(store)
    const query = client.query({ collection: 'records' })
    client.upsert('records', 'r1', { title: 'optimistic' })
    await tick()

    // Data moves for the subscriber, but the contract is that the status
    // stays `loading` until the collection's stored records are in.
    expect(query.getSnapshot().status).toBe('loading')
    expect(query.getSnapshot().data[0]?.value).toEqual({ title: 'optimistic' })

    release()
    await query.ready()
    await tick()
    expect(query.getSnapshot().status).toBe('ready')
    expect(query.getSnapshot().data[0]?.value).toEqual({ title: 'optimistic' })
    query.destroy()
  })
})

describe('pull persistence', () => {
  /**
   * One page holding a single remote-authored upsert, then quiet. The cursor
   * ends at 1, so a later sync (or a reloaded client) never sees the operation
   * echoed again — exactly the situation where the record itself has to have
   * been made durable.
   */
  function remoteOnlyTransport(): SyncTransport {
    return {
      async push(request) {
        return {
          decisions: request.operations.map((operation) => ({
            kind: 'accepted' as const,
            operationId: operation.id,
          })),
        }
      },
      async pull(request) {
        if ((request.cursor ?? 0) >= 1) {
          return { kind: 'operations', operations: [], cursor: request.cursor ?? 1 }
        }
        return {
          kind: 'operations',
          operations: [
            {
              remoteSequence: 1,
              operation: {
                id: 'remote-op-1',
                key: { scope: 'workspace:test', collection: 'records', record_id: 'r-remote' },
                actor_id: 'actor-2',
                timestamp: { wall_time_ms: 1_700_000_000_500, counter: 0, actor_id: 'actor-2' },
                kind: { type: 'upsert', value: { title: 'from remote' } },
              },
            },
          ],
          cursor: 1,
          hasMore: false,
        }
      },
    }
  }

  it('keeps a pulled remote record across a reload of the same store', async () => {
    const storage = memoryStore()
    const transport = remoteOnlyTransport()

    const first = await makeClient({ storage, transport, sync: { autoStart: false } })
    await first.sync.syncNow()

    const before = first.query({ collection: 'records' })
    await before.ready()
    await tick()
    expect(before.getSnapshot().data.map((r) => r.value)).toEqual([{ title: 'from remote' }])
    before.destroy()
    await first.close()

    // Same store, fresh client: a browser reload. The cursor is already past
    // the operation and its id is in the applied set, so nothing will ever
    // deliver it again — hydration alone must restore the record.
    const second = await makeClient({ storage, transport, sync: { autoStart: false } })
    const after = second.query({ collection: 'records' })
    await after.ready()
    await tick()
    expect(after.getSnapshot().data.map((r) => r.value)).toEqual([{ title: 'from remote' }])
    after.destroy()

    // And a manual sync must not resurrect or duplicate anything either.
    await second.sync.syncNow()
    const resynced = second.query({ collection: 'records' })
    await resynced.ready()
    await tick()
    expect(resynced.getSnapshot().data).toHaveLength(1)
    resynced.destroy()
    await second.close()
  })
})

describe('client lifecycle', () => {
  it('can be reopened after close', async () => {
    // Workspace switching depends on this. The old provider set a `disposed`
    // flag that never cleared, so it silently never reconnected.
    const client = await makeClient()
    await client.close()
    await expect(makeClient()).resolves.toBeDefined()
  })
})

/** Two microtask turns: one for the engine's coalescing, one for the listener. */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('writes from another context', () => {
  const scope = 'workspace:test'

  function engineRecord(collection: string, recordId: string, value: unknown): EngineRecord {
    return {
      key: { scope, collection, record_id: recordId },
      value,
      version: { wall_time_ms: 1, counter: 0, actor_id: 'other-tab' },
      field_versions: {},
      deleted_at: null,
      updated_by: 'other-tab',
    }
  }

  /** A store that reports other contexts' writes, the way a shared store does. */
  function sharedStore(): ReturnType<typeof memoryStore> & {
    fromAnotherContext(write: StoreWrite): Promise<void>
  } {
    const base = memoryStore()
    const listeners = new Set<(write: StoreWrite) => void>()
    return Object.assign(base, {
      subscribe(listener: (write: StoreWrite) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async fromAnotherContext(write: StoreWrite) {
        await base.commit(write)
        for (const listener of [...listeners]) listener(write)
      },
    })
  }

  it('updates pinned on-demand records from another context without hydrating unloaded rows', async () => {
    const store = sharedStore()
    store.seedRecord(engineRecord('records', 'r1', { n: 1 }))
    const client = await makeClient({ storage: store, collections: { records: { mode: 'engine-native', hydration: 'on-demand' } } })
    const row = client.liveRecord('records', 'r1')
    await row.ready()
    await store.fromAnotherContext({ records: [engineRecord('records', 'r1', { n: 2 }), engineRecord('records', 'unloaded', {})] })
    await tick()
    expect(row.getSnapshot().data?.value).toEqual({ n: 2 })
    expect(client.evictRecords('records', ['unloaded'])).toBe(0)
    row.destroy()
    await client.close()
  })

  it("projects another context's record without waiting for the server", async () => {
    const store = sharedStore()
    const client = await makeClient({ storage: store })
    const query = client.query({ collection: 'records' })
    await query.ready()
    expect(query.getSnapshot().data).toHaveLength(0)

    await store.fromAnotherContext({ records: [engineRecord('records', 'r1', { n: 1 })] })
    await tick()

    expect(query.getSnapshot().data).toHaveLength(1)
    expect(query.getSnapshot().data[0]?.value).toEqual({ n: 1 })
    query.destroy()
    await client.close()
  })

  it('reports the change as remote, not as a local edit', async () => {
    const store = sharedStore()
    const client = await makeClient({ storage: store })
    const seen: string[] = []
    client.subscribeChanges((changes) => seen.push(changes.origin))

    await store.fromAnotherContext({ records: [engineRecord('records', 'r1', { n: 1 })] })
    await tick()

    expect(seen).toEqual(['remote'])
    await client.close()
  })

  it("carries another context's unpushed write as pending, then releases it", async () => {
    const store = sharedStore()
    const client = await makeClient({ storage: store })
    const query = client.query({ collection: 'records' })
    await query.ready()

    const operation: Operation = {
      id: 'op-from-another-tab',
      key: { scope, collection: 'records', record_id: 'r1' },
      actor_id: 'other-tab',
      timestamp: { wall_time_ms: 1, counter: 0, actor_id: 'other-tab' },
      kind: { upsert: { value: { n: 1 } } },
    } as unknown as Operation

    await store.fromAnotherContext({
      operations: [operation],
      records: [engineRecord('records', 'r1', { n: 1 })],
    })
    await tick()
    expect(query.getSnapshot().data[0]?.pending).toBe(true)

    await store.fromAnotherContext({
      statusUpdates: [{ operationId: operation.id, status: 'accepted', remoteSequence: 7 }],
    })
    await tick()
    expect(query.getSnapshot().data[0]?.pending).toBe(false)

    query.destroy()
    await client.close()
  })

  it('stops listening once the client is closed', async () => {
    const store = sharedStore()
    const client = await makeClient({ storage: store })
    await client.close()

    await expect(
      store.fromAnotherContext({ records: [engineRecord('records', 'r1', { n: 1 })] }),
    ).resolves.toBeUndefined()
  })
})

describe('collections discovered at runtime', () => {
  /** A REST resource that records what the transport asked it to do. */
  function recordingResource(log: string[], label: string) {
    return {
      async list() {
        log.push(`list:${label}`)
        return []
      },
      async create(value: unknown) {
        log.push(`create:${label}`)
        return value
      },
      async update(recordId: string) {
        log.push(`update:${label}:${recordId}`)
      },
      async remove(recordId: string) {
        log.push(`remove:${label}:${recordId}`)
      },
      toRecord(item: { id: string }) {
        return { recordId: item.id, value: item }
      },
    }
  }

  it('asks the resolver for a collection that `collections` does not name', async () => {
    const seen: string[] = []
    const client = await makeClient({
      resolveCollection: (collection) => {
        seen.push(collection)
        return collection.startsWith('data:') ? { mode: 'passthrough', resource: recordingResource([], collection) } : undefined
      },
    })

    // `passthrough` is pushed inline at mutation time, so the mode being
    // honoured is observable: the operation never joins the durable queue.
    client.upsert('data:repo-1', 'r1', { title: 'from a resolved collection' })
    await tick()

    expect(seen).toContain('data:repo-1')
    await client.close()
  })

  it('caches the resolver answer, including "no answer"', async () => {
    const calls: string[] = []
    const client = await makeClient({
      resolveCollection: (collection) => {
        calls.push(collection)
        return undefined
      },
    })

    client.upsert('records', 'r1', { n: 1 })
    client.upsert('records', 'r2', { n: 2 })
    await tick()

    // Once for the collection, not once per mutation: a resolver that is asked
    // repeatedly could answer differently and make the mode non-deterministic.
    expect(calls.filter((collection) => collection === 'records')).toHaveLength(1)
    await client.close()
  })

  it('never consults the resolver for a collection `collections` already names', async () => {
    const calls: string[] = []
    const client = await makeClient({
      collections: { records: { mode: 'engine-native' } },
      resolveCollection: (collection) => {
        calls.push(collection)
        return undefined
      },
    })

    client.upsert('records', 'r1', { n: 1 })
    await tick()

    expect(calls).not.toContain('records')
    await client.close()
  })

  it('routes a resolved rest-backed collection through the REST transport', async () => {
    const log: string[] = []
    const engine: SyncTransport = {
      async push(request) {
        for (const operation of request.operations) log.push(`engine:${operation.key.collection}`)
        return { decisions: [] }
      },
      async pull(request) {
        return { kind: 'operations', operations: [], cursor: request.cursor }
      },
    }

    const client = await makeClient({
      transport: engine,
      sync: { autoStart: false, pushDebounceMs: 0 },
      resolveCollection: (collection) =>
        collection.startsWith('data:')
          ? { mode: 'rest-backed', resource: recordingResource(log, collection) }
          : undefined,
    })

    client.upsert('data:repo-1', 'r1', { title: 'rest' })
    client.upsert('records', 'r2', { title: 'engine' })
    await tick()
    await client.sync.syncNow()

    // The mode router split them: one went to REST, the other to the engine.
    // (The REST call is `update` rather than `create` because the optimistic
    // value is already in the projection — that classification is the
    // transport's, not the resolver's, and is asserted elsewhere.)
    expect(log).toContain('update:data:repo-1:r1')
    expect(log).toContain('engine:records')
    expect(log).not.toContain('engine:data:repo-1')
    await client.close()
  })

  it('rejects a resolved rest-backed collection with no resource', async () => {
    const client = await makeClient({
      resolveCollection: () => ({ mode: 'rest-backed' } as never),
    })

    expect(() => client.upsert('data:repo-1', 'r1', { n: 1 })).toThrow(/has no REST resource/)
    await client.close()
  })
})

describe('atomic batch contract', () => {
  it('does not apply anything when the transport is incapable', async () => {
    const client = await makeClient({ sync: { autoStart: false } })
    expect(() => client.transact([{ collection: 'records', recordId: 'r1', kind: { type: 'upsert', value: {} } }], { atomic: true })).toThrow(/atomic/)
    expect(client.pendingCount()).toBe(0)
    expect(await client.storage.loadPendingOperations('workspace:test')).toHaveLength(0)
    await client.close()
  })

  it('persists batch membership and retries the same envelope after reopening', async () => {
    const store = memoryStore()
    const push = vi.fn(async (request) => ({ decisions: request.operations.map((op: Operation) => ({ kind: 'accepted' as const, operationId: op.id, remoteSequence: 1 })) }))
    const transport: SyncTransport = { supportsAtomic: true, push, pull: async () => ({ kind: 'operations', operations: [], cursor: null }) }
    const first = await makeClient({ storage: store, transport, sync: { autoStart: false } })
    const handle = first.transact([
      { collection: 'records', recordId: 'a', kind: { type: 'upsert', value: { n: 1 } } },
      { collection: 'records', recordId: 'b', kind: { type: 'upsert', value: { n: 2 } } },
    ], { atomic: true })
    await handle.local
    const queued = await store.loadPendingOperations('workspace:test')
    await first.close()
    const second = await makeClient({ storage: store, transport, sync: { autoStart: false } })
    await second.sync.syncNow()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0]![0].atomicBatchId).toBe((queued[0]!.operation.metadata as { photon_batch: { id: string } }).photon_batch.id)
    expect(push.mock.calls[0]![0].operations).toEqual(queued.map(op => op.operation))
    expect(second.pendingCount()).toBe(0)
    await second.close()
  })

  it('leaves the complete batch pending if a server returns mixed decisions', async () => {
    const store = memoryStore()
    const transport: SyncTransport = {
      supportsAtomic: true,
      push: async request => ({ decisions: request.operations.map((op, i) => i === 0 ? { kind: 'accepted', operationId: op.id } : { kind: 'rejected', operationId: op.id, reason: 'bad' }) }),
      pull: async () => ({ kind: 'operations', operations: [], cursor: null }),
    }
    const client = await makeClient({ storage: store, transport, sync: { autoStart: false } })
    await client.transact(['a','b'].map(recordId => ({ collection: 'records', recordId, kind: { type: 'upsert' as const, value: {} } })), { atomic: true }).local
    await client.sync.syncNow()
    expect(client.pendingCount()).toBe(2)
    expect(await store.loadPendingOperations('workspace:test')).toHaveLength(2)
    expect(client.sync.getStatus().lastError?.message).toMatch(/partial or mixed/)
    await client.close()
  })
})

function checkpoint(id: string, value: unknown, sequence = 1) {
  return { record: { key: { scope: 'workspace:test', collection: 'records', record_id: id }, value, version: { wall_time_ms: 1, counter: sequence, actor_id: 'server' }, field_versions: {}, deleted_at: null, updated_by: 'server' } as EngineRecord, sequence }
}

function selectionTransport(pullSelection: NonNullable<SyncTransport['pullSelection']>): SyncTransport {
  return { pullSelection, pull: async () => { throw new Error('full scope must not be pulled') }, push: async request => ({ decisions: request.operations.map(op => ({ kind: 'accepted', operationId: op.id, remoteSequence: 100 })) }) }
}

describe('partial sync and local cache', () => {
  it('distinguishes uninitialized, partial and complete empty results and resumes the durable cursor', async () => {
    const store = memoryStore()
    const seen: unknown[] = []
    const transport = selectionTransport(async request => {
      seen.push(request.cursor)
      return { records: [], removals: [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 10, afterId: null }, hasMore: request.cursor === null }
    })
    const first = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false, selectionPageBudget: 1 } })
    const sub = first.subscribeSync('empty', { collection: 'records' })
    expect(sub.getSnapshot().status).toBe('uninitialized')
    await sub.refresh()
    expect(sub.getSnapshot().status).toBe('partial')
    await first.close()
    const second = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    const resumed = second.subscribeSync('empty', { collection: 'records' })
    await resumed.refresh()
    expect(seen[1]).toMatchObject({ position: 10 })
    expect(resumed.getSnapshot().status).toBe('complete')
    expect((await second.readPage({ collection: 'records', limit: 10 })).data).toEqual([])
    expect(store.writes.some(write => write.selectionStates?.[0]?.status === 'complete' && write.memberships)).toBe(true)
    await second.close()
  })

  it('does not hydrate a large on-demand collection and reloads evicted rows by ID', async () => {
    const store = memoryStore()
    for (let i = 0; i < 1000; i++) store.seedRecord(checkpoint(String(i).padStart(4, '0'), { n: i }).record)
    const client = await makeClient({ storage: store, collections: { records: { mode: 'engine-native', hydration: 'on-demand' } }, cache: { maxRecords: 2 }, sync: { autoStart: false } })
    expect(store.loadRecordsCalls[0]!.served).toBe(0)
    const page = await client.readPage({ collection: 'records', limit: 2 })
    expect(page.data).toHaveLength(2)
    expect(page.hasMore).toBe(true)
    const pinned = client.liveRecord('records', '0000')
    await pinned.ready()
    await client.readPage({ collection: 'records', afterId: '0001', limit: 2 })
    expect(client.evictRecords('records', ['0000'])).toBe(0)
    pinned.destroy()
    expect(client.evictRecords('records', ['0000'])).toBe(1)
    const reread = client.liveRecord<{ n: number }>('records', '0000')
    await reread.ready()
    expect(reread.getSnapshot().data?.value.n).toBe(0)
    expect(store.loadRecordsCalls).toHaveLength(1)
    await client.close()
  })

  it('preserves a shared record until the last selection loses membership', async () => {
    let remove = false
    const transport = selectionTransport(async request => ({
      records: remove ? [] : [checkpoint('a', { n: 1 })],
      removals: remove ? [{ recordId: 'a', reason: 'out_of_scope' }] : [],
      cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: remove ? 2 : 1, afterId: null }, hasMore: false,
    }))
    const client = await makeClient({ transport, sync: { mode: 'scoped', autoStart: false } })
    const a = client.subscribeSync('first', { collection: 'records' })
    const b = client.subscribeSync('second', { collection: 'records', recordIds: ['a'] })
    await a.refresh(); await b.refresh()
    remove = true
    await a.refresh()
    expect((await client.readPage({ collection: 'records', limit: 10 })).data).toHaveLength(1)
    await b.refresh()
    expect((await client.readPage({ collection: 'records', limit: 10 })).data).toHaveLength(0)
    await client.close()
  })

  it('holds an out-of-scope pending edit across restart and prunes it after acknowledgement', async () => {
    const store = memoryStore()
    let remove = false
    const transport = selectionTransport(async request => ({ records: remove ? [] : [checkpoint('a', { n: 1 })], removals: remove ? [{ recordId: 'a', reason: 'out_of_scope' }] : [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: remove ? 2 : 1, afterId: null }, hasMore: false }))
    const first = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    await first.subscribeSync('s', { collection: 'records' }).refresh()
    await first.patch('records', 'a', { n: 2 }).local
    remove = true
    await first.sync.syncNow() // acceptance happens first, so test offline removal through a direct subscription instead
    await first.close()
    // Fresh pending intent proves deferred eviction is durable independently
    // of the sync loop's normal push-before-pull order.
    const second = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    await second.upsert('records', 'a', { n: 3 }).local
    const sub = second.subscribeSync('s', { collection: 'records' })
    await sub.refresh()
    expect((await second.readPage({ collection: 'records', limit: 10 })).data[0]?.pending).toBe(true)
    await second.close()
    const third = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    await third.sync.syncNow()
    await tick(); await tick()
    expect((await third.readPage({ collection: 'records', limit: 10 })).data).toHaveLength(0)
    await third.close()
  })

  it('quarantines a revoked pending edit and does not automatically resend it after restart', async () => {
    const store = memoryStore()
    let revoke = false
    const push = vi.fn(async () => ({ decisions: [] }))
    const transport = { ...selectionTransport(async request => ({ records: revoke ? [] : [checkpoint('a', { n: 1 })], removals: revoke ? [{ recordId: 'a', reason: 'revoked' }] : [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: revoke ? 2 : 1, afterId: null }, hasMore: false })), push }
    const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    const sub = client.subscribeSync('s', { collection: 'records' })
    await sub.refresh()
    const edit = client.patch('records', 'a', { n: 3 }); await edit.local
    revoke = true; await sub.refresh()
    expect((await edit.settled).status).toBe('conflict')
    expect((await client.readPage({ collection: 'records', limit: 10 })).data).toHaveLength(0)
    expect(client.conflicts()[0]?.localValue).toEqual({ n: 3 })
    await client.close()
    const reopened = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    await reopened.sync.syncNow()
    expect(push).not.toHaveBeenCalled()
    expect(reopened.conflicts()).toHaveLength(1)
    await reopened.resolveConflict(reopened.conflicts()[0]!.id, { keep: 'local' })
    expect((await reopened.readPage<{ n: number }>({ collection: 'records', limit: 10 })).data[0]?.value.n).toBe(3)
    expect(reopened.pendingCount()).toBe(1)
    await reopened.close()
  })

  it('does not double apply an increment when a push response was lost', async () => {
    let accepted: Operation | null = null
    const transport = selectionTransport(async request => ({
      records: [checkpoint('a', { n: accepted ? 11 : 10 }, accepted ? 2 : 1)], removals: [],
      receipts: accepted ? [{ operationId: accepted.id, remoteSequence: 2 }] : [],
      cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: accepted ? 2 : 1, afterId: null }, hasMore: false,
    }))
    transport.push = async request => { accepted = request.operations[0]!; throw new Error('lost response') }
    const client = await makeClient({ transport, sync: { mode: 'scoped', autoStart: false } })
    await client.subscribeSync('s', { collection: 'records' }).refresh()
    const edit = client.increment('records', 'a', 'n', 1); await edit.local
    await client.sync.syncNow()
    expect((await edit.settled).status).toBe('accepted')
    expect((await client.readPage<{ n: number }>({ collection: 'records', limit: 10 })).data[0]?.value.n).toBe(11)
    expect(client.pendingCount()).toBe(0)
    await client.close()
  })

  it('keeps cursor and state unchanged when a local page commit fails', async () => {
    const store = memoryStore()
    const transport = selectionTransport(async request => ({ records: [checkpoint('a', {})], removals: [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 2, afterId: null }, hasMore: false }))
    const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
    const sub = client.subscribeSync('s', { collection: 'records' })
    const original = store.commit
    store.commit = async () => { throw new Error('disk full') }
    await expect(sub.refresh()).rejects.toThrow('disk full')
    expect(sub.getSnapshot().status).toBe('uninitialized')
    expect(await store.getSelectionState!('workspace:test', 's')).toBeNull()
    store.commit = original
    await sub.refresh()
    expect(sub.getSnapshot().status).toBe('complete')
    await client.close()
  })
})

it('releases a subscription cache and can reuse the id with a new selector', async () => {
  const store = memoryStore()
  const transport = selectionTransport(async request => ({ records: [checkpoint('a', { n: 1 })], removals: [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 1, afterId: null }, hasMore: false }))
  const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  const sub = client.subscribeSync('replaceable', { collection: 'records' })
  await sub.refresh()
  await sub.release()
  expect((await client.readPage({ collection: 'records', limit: 10 })).data).toEqual([])
  expect(await store.getSelectionState!('workspace:test', 'replaceable')).toBeNull()
  const next = client.subscribeSync('replaceable', { collection: 'records', recordIds: ['a'] })
  await next.refresh()
  expect(next.getSnapshot().status).toBe('complete')
  await client.close()
})

it('persists an atomic rejection rollback so reopening cannot resurrect rejected data', async () => {
  const store = memoryStore()
  const transport: SyncTransport = { supportsAtomic: true,
    push: async request => ({ decisions: request.operations.map(op => ({ kind: 'rejected', operationId: op.id, reason: 'invalid' })) }),
    pull: async () => ({ kind: 'operations', operations: [], cursor: null }),
  }
  const client = await makeClient({ storage: store, transport, sync: { autoStart: false } })
  const mutation = client.transact(['a', 'b'].map(recordId => ({ collection: 'records', recordId, kind: { type: 'upsert' as const, value: { n: 1 } } })), { atomic: true })
  await client.sync.syncNow()
  expect((await mutation.settled).status).toBe('rejected')
  await client.close()
  const reopened = await makeClient({ storage: store, sync: { autoStart: false } })
  expect((await reopened.readPage({ collection: 'records', limit: 10 })).data).toEqual([])
  expect(store.writes.some(w => w.statusUpdates?.length === 2 && w.deleteRecords?.length === 2)).toBe(true)
  await reopened.close()
})

it('serializes a checkpoint commit with an increment arriving during its store read', async () => {
  const store = memoryStore()
  const transport = selectionTransport(async request => ({ records: [checkpoint('a', { n: 10 })], removals: [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 1, afterId: null }, hasMore: false }))
  const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  const interest = client.subscribeSync('s', { collection: 'records' })
  await interest.refresh()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  const original = store.loadAcceptedOperations
  store.loadAcceptedOperations = async (...args) => { entered(); await blocked; return original(...args) }
  const refresh = interest.refresh()
  await reading
  const edit = client.increment('records', 'a', 'n', 1)
  release()
  await refresh
  await edit.local
  expect((await client.readPage<{ n: number }>({ collection: 'records', limit: 10 })).data[0]?.value.n).toBe(11)
  await client.close()
  const reopened = await makeClient({ storage: store, sync: { autoStart: false } })
  expect((await reopened.readPage<{ n: number }>({ collection: 'records', limit: 10 })).data[0]?.value.n).toBe(11)
  await reopened.close()
})

it('orders a slow local page before a revocation so the page cannot resurrect its record', async () => {
  const store = memoryStore()
  let revoked = false
  const transport = selectionTransport(async request => ({ records: revoked ? [] : [checkpoint('a', { n: 1 })], removals: revoked ? [{ recordId: 'a', reason: 'revoked' }] : [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: revoked ? 2 : 1, afterId: null }, hasMore: false }))
  const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  const interest = client.subscribeSync('s', { collection: 'records' })
  await interest.refresh()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  const original = store.readRecordPage!
  store.readRecordPage = async (...args) => { const page = await original(...args); entered(); await gate; return page }
  const read = client.readPage({ collection: 'records', limit: 10 })
  await reading
  revoked = true
  let finished = false
  const refresh = interest.refresh().then(() => { finished = true })
  await tick()
  expect(finished).toBe(false)
  release()
  await read
  await refresh
  const record = client.liveRecord('records', 'a')
  expect(record.getSnapshot().data).toBeNull()
  record.destroy()
  await client.close()
})

it('accepts snapshot progress in server collation order', async () => {
  let page = 0
  const transport = selectionTransport(async request => {
    const id = ['a', 'B'][page++]
    return { records: id ? [checkpoint(id, {})] : [], removals: [], cursor: { scope: 'workspace:test', selector: request.selector, phase: id ? 'snapshot' : 'delta', position: 2, afterId: id ?? null }, hasMore: !!id }
  })
  const client = await makeClient({ transport, sync: { mode: 'scoped', autoStart: false } })
  const sub = client.subscribeSync('mixed-case', { collection: 'records' })
  await sub.refresh()
  expect(sub.getSnapshot().status).toBe('complete')
  expect((await client.readPage({ collection: 'records', limit: 10 })).data).toHaveLength(2)
  await client.close()
})

it('refreshes valid subscriptions after an earlier selector fails', async () => {
  const transport = selectionTransport(async request => {
    if (request.selector.collection === 'broken') throw new Error('selector unavailable')
    return { records: [checkpoint('a', {})], removals: [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 1, afterId: null }, hasMore: false }
  })
  const client = await makeClient({ transport, sync: { mode: 'scoped', autoStart: false } })
  const broken = client.subscribeSync('bad', { collection: 'broken' })
  const good = client.subscribeSync('good', { collection: 'records' })
  await client.sync.syncNow()
  expect(broken.getSnapshot().error?.message).toContain('unavailable')
  expect(good.getSnapshot().status).toBe('complete')
  await client.close()
})

it.each(['rejected', 'conflict'] as const)('prunes deferred records after a %s decision while preserving recovery evidence', async kind => {
  const store = memoryStore()
  let remove = false
  const transport: SyncTransport = { ...selectionTransport(async request => ({ records: remove ? [] : [checkpoint('a', { n: 1 })], removals: remove ? [{ recordId: 'a', reason: 'out_of_scope' }] : [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 2, afterId: null }, hasMore: false })), push: async request => ({ decisions: request.operations.map(op => ({ kind, operationId: op.id, reason: 'denied' })) }) }
  const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  const sub = client.subscribeSync('s', { collection: 'records' })
  await sub.refresh()
  await client.patch('records', 'a', { n: 2 }).local
  remove = true
  await sub.refresh()
  await client.sync.syncNow()
  await tick(); await tick()
  expect((await store.loadRecords('workspace:test'))).toHaveLength(0)
  expect(await store.getDeferredEviction!('workspace:test', 'records', 'a')).toBe(false)
  if (kind === 'conflict') expect(client.conflicts()[0]?.localValue).toEqual({ n: 2 })
  await client.close()
})

it.each([false, true])('restores an accessible atomic sibling durably after quarantine (concurrent edit: %s)', async concurrent => {
  const store = memoryStore()
  let remove = false
  const transport: SyncTransport = { ...selectionTransport(async request => ({ records: remove ? [] : ['a', 'b'].map(id => checkpoint(id, { n: 1 })), removals: remove ? [{ recordId: 'a', reason: 'revoked' }] : [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 2, afterId: null }, hasMore: false })), supportsAtomic: true }
  const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  const sub = client.subscribeSync('s', { collection: 'records' })
  await sub.refresh()
  await client.transact(['a', 'b'].map(recordId => ({ collection: 'records', recordId, kind: { type: 'upsert' as const, value: { n: 2 } } })), { atomic: true }).local
  remove = true; await sub.refresh()
  const sibling = client.conflicts().find(row => row.key.record_id === 'b')!
  expect(sibling.reason).toBe('atomic_batch_quarantined')
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  const original = store.loadAcceptedOperations
  if (concurrent) store.loadAcceptedOperations = async (...args) => { entered(); await blocked; return original(...args) }
  const resolving = client.resolveConflict(sibling.id, { keep: 'remote' })
  let concurrentLocal: Promise<unknown> | undefined
  if (concurrent) {
    await reading
    concurrentLocal = client.increment('records', 'b', 'n', 1).local
    release()
  }
  await resolving
  await concurrentLocal
  expect((await store.loadRecords('workspace:test')).find(row => row.key.record_id === 'b')?.value).toEqual({ n: concurrent ? 2 : 1 })
  expect(store.writes.some(write => write.resolveConflictIds?.includes(sibling.id) && write.records?.some(record => record.key.record_id === 'b'))).toBe(true)
  expect(client.pendingCount()).toBe(concurrent ? 1 : 0)
  await client.close()
})

it('retains newly read cache rows after a prior row was removed', async () => {
  const store = memoryStore()
  let remove = false
  const transport = selectionTransport(async request => ({ records: remove ? [] : ['a', 'b'].map(id => checkpoint(id, {})), removals: remove ? [{ recordId: 'a', reason: 'deleted' }] : [], cursor: { scope: 'workspace:test', selector: request.selector, phase: 'delta', position: 2, afterId: null }, hasMore: false }))
  const client = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false }, collections: { records: { mode: 'engine-native', hydration: 'on-demand' } }, cache: { maxRecords: 1 } })
  const sub = client.subscribeSync('s', { collection: 'records' })
  await sub.refresh()
  await client.readPage({ collection: 'records', recordIds: ['a'], limit: 1 })
  remove = true; await sub.refresh()
  await client.readPage({ collection: 'records', recordIds: ['b'], limit: 1 })
  expect(client.evictRecords('records', ['b'])).toBe(1)
  await client.close()
})

it('revalidates held IDs in bounded pages and resumes that scan after restart', async () => {
  const store = memoryStore()
  const selector = { collection: 'records' }
  await store.commit({ memberships: Array.from({ length: 401 }, (_, i) => ({ scope: 'workspace:test', subscriptionId: 's', collection: 'records', recordId: String(i).padStart(3, '0') })) })
  const seen: string[][] = []
  const transport = selectionTransport(async request => {
    seen.push([...(request.knownRecordIds ?? [])])
    return { records: [], removals: [], cursor: { scope: 'workspace:test', selector, phase: 'delta', position: 1, afterId: null }, hasMore: false }
  })
  const first = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  await first.subscribeSync('s', selector).refresh()
  await first.close()
  const second = await makeClient({ storage: store, transport, sync: { mode: 'scoped', autoStart: false } })
  const sub = second.subscribeSync('s', selector)
  await sub.refresh(); await sub.refresh(); await sub.refresh()
  expect(seen.map(ids => ids.length)).toEqual([200, 200, 1, 200])
  expect(seen[1]?.[0]).toBe('200')
  expect(seen[2]).toEqual(['400'])
  expect(seen[3]?.[0]).toBe('000')
  await second.close()
})
