/**
 * Client behaviour that the whole design rests on.
 *
 * Uses a fake kernel and an in-memory store so these stay fast and
 * deterministic; the real kernel is covered by the playground's integration
 * test and by the Rust suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPhotonClient, type PhotonClient } from './client.js'
import type { PhotonKernelModule } from './kernel.js'
import type { LoadRecordsOptions, LocalStore, StoreWrite } from './store.js'
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
    async getCursor() {
      return null
    },
    async commit(write) {
      writes.push(write)
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
        if (existing) operations.set(update.operationId, { ...existing, status: update.status })
      }
      for (const conflict of write.conflicts ?? []) conflicts.push(conflict)
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

async function makeClient(overrides: { transport?: never } = {}): Promise<PhotonClient> {
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
