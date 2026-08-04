/**
 * The claim this file exists to defend: component code does not depend on the
 * collection mode.
 *
 * The same sequence of client calls is run against a server that speaks the
 * engine protocol and against a plain REST API, and the observable state
 * transitions — optimistic value, pending flag, durability, rollback on
 * rejection — must match. That is what makes upgrading a collection from
 * passthrough to rest-backed to engine-native a one-line config change.
 */
import { describe, expect, it, vi } from 'vitest'

import { createPhotonClient, type PhotonClient, type PhotonClientOptions } from '../client.js'
import { createRestTransport, type RestResource } from './index.js'
import type { PhotonKernelModule } from '../kernel.js'
import type { LocalStore } from '../store.js'
import type { SyncTransport } from '../sync/types.js'
import type { EngineRecord, Operation } from '../types.js'

// Reuses the same fake kernel and store shape as client.test.ts, kept local so
// neither test file constrains the other's fixtures.
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
      } else this.counter += 1
      return { wall_time_ms: this.wall, counter: this.counter, actor_id: this.actor }
    }
    buildOperation(intentJson: string, nowMs: number) {
      const intent = JSON.parse(intentJson)
      return JSON.stringify({
        id: `op-${this.wall}-${this.counter}-${Math.random()}`,
        key: intent.key,
        actor_id: this.actor,
        timestamp: this.stamp(nowMs),
        kind: intent.kind,
      })
    }
    applyOperation(currentJson: string | null | undefined, operationJson: string) {
      return JSON.stringify(
        project(currentJson ? JSON.parse(currentJson) : null, JSON.parse(operationJson)),
      )
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
      const records = new Map<string, EngineRecord>(
        batch.records.map((r: EngineRecord) => [key(r.key), r]),
      )
      const applied: string[] = []
      for (const operation of batch.operations as Operation[]) {
        records.set(key(operation.key), project(records.get(key(operation.key)) ?? null, operation))
        applied.push(operation.id)
      }
      return JSON.stringify({
        records: [...records.values()],
        applied_operation_ids: applied,
        skipped_operation_ids: [],
      })
    }
    observeTimestamp() {}
    currentTimestamp() {
      return JSON.stringify({ wall_time_ms: this.wall, counter: this.counter, actor_id: this.actor })
    }
  }
  return { PhotonKernel } as unknown as PhotonKernelModule
}

function key(k: EngineRecord['key']) {
  return `${k.scope}/${k.collection}/${k.record_id}`
}

function project(current: EngineRecord | null, operation: Operation): EngineRecord {
  const base = current?.value && typeof current.value === 'object' ? { ...(current.value as object) } : {}
  let value: unknown = base
  let deletedAt = current?.deleted_at ?? null
  if (operation.kind.type === 'upsert') {
    value = operation.kind.value
    deletedAt = null
  } else if (operation.kind.type === 'patch') {
    value = { ...base, ...operation.kind.fields }
  } else if (operation.kind.type === 'delete') {
    deletedAt = operation.timestamp
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

function memoryStore(): LocalStore {
  const records = new Map<string, EngineRecord>()
  const operations = new Map<string, { operation: Operation; status: string; seq: number }>()
  let sequence = 0
  return {
    async migrate() {},
    async loadRecords() {
      return [...records.values()]
    },
    async loadPendingOperations() {
      return [...operations.values()]
        .filter((o) => o.status === 'pending')
        .map((o) => ({
          operation: o.operation,
          status: 'pending' as const,
          localSequence: o.seq,
          remoteSequence: null,
          receivedAtMs: 0,
        }))
    },
    async loadAcceptedOperations(_s, collection, recordId) {
      return [...operations.values()]
        .filter(
          (o) =>
            o.status === 'accepted' &&
            o.operation.key.collection === collection &&
            o.operation.key.record_id === recordId,
        )
        .sort((a, b) => a.seq - b.seq)
        .map((o) => ({
          operation: o.operation,
          status: 'accepted' as const,
          localSequence: o.seq,
          remoteSequence: null,
          receivedAtMs: 0,
        }))
    },
    async loadOperationIds() {
      return [...operations.keys()]
    },
    async loadConflicts() {
      return []
    },
    async getCursor() {
      return null
    },
    async commit(write) {
      for (const operation of write.operations ?? []) {
        if (!operations.has(operation.id)) {
          sequence += 1
          operations.set(operation.id, { operation, status: 'pending', seq: sequence })
        }
      }
      for (const record of write.records ?? []) records.set(key(record.key), record)
      for (const update of write.statusUpdates ?? []) {
        const existing = operations.get(update.operationId)
        if (existing) existing.status = update.status
      }
    },
    async stats() {
      return {
        operations: { pending: 0, accepted: 0, rejected: 0, conflict: 0 },
        recordsByCollection: {},
      }
    },
    raw() {
      return { dataDir: `memory-${Math.random()}` }
    },
    async close() {},
  }
}

async function client(
  transport: SyncTransport | undefined,
  extra: Partial<PhotonClientOptions> = {},
): Promise<PhotonClient> {
  let now = 1_700_000_000_000
  return createPhotonClient({
    scope: 'workspace:test',
    actorId: 'actor-1',
    storage: memoryStore(),
    kernel: fakeKernelModule(),
    ...(transport ? { transport } : {}),
    sync: { autoStart: false },
    clock: () => (now += 1),
    ...extra,
  })
}

/** A server that speaks the engine protocol and accepts everything. */
function engineTransport(verdict: 'accept' | 'reject' = 'accept'): SyncTransport {
  return {
    async push(request) {
      return {
        decisions: request.operations.map((operation) =>
          verdict === 'accept'
            ? ({ kind: 'accepted', operationId: operation.id } as const)
            : ({ kind: 'rejected', operationId: operation.id, reason: 'nope' } as const),
        ),
      }
    },
    async pull() {
      return { kind: 'operations', operations: [], cursor: null }
    },
  }
}

/**
 * The same behaviour, expressed as a plain REST API.
 *
 * Stateful on purpose: a fixture that accepts a create and then reports an
 * empty collection is not a REST server, and testing against that lie would
 * hide real behaviour rather than reveal it.
 */
function issuesResource(verdict: 'accept' | 'reject' = 'accept'): {
  resource: RestResource<never>
  rows: Map<string, Record<string, unknown>>
} {
  const rows = new Map<string, Record<string, unknown>>()
  const fail = async () => {
    throw Object.assign(new Error('nope'), { status: 422 })
  }
  const resource = {
    list: async () => ({ items: [...rows.values()], complete: true }),
    create:
      verdict === 'accept'
        ? async (value: Record<string, unknown>) => {
            const id = (value.id as string | undefined) ?? 'r1'
            const row = { ...value, id }
            rows.set(id, row)
            return row
          }
        : fail,
    update:
      verdict === 'accept'
        ? async (id: string, fields: Record<string, unknown>) => {
            rows.set(id, { ...(rows.get(id) ?? { id }), ...fields })
            return undefined
          }
        : fail,
    remove:
      verdict === 'accept'
        ? async (id: string) => {
            rows.delete(id)
          }
        : fail,
    toRecord: (item: { id?: string }) => ({ recordId: item.id ?? 'r1', value: item }),
  } as unknown as RestResource<never>
  return { resource, rows }
}

/**
 * Every mode is created exactly as the README shows: engine-native through a
 * `transport`, the other two through the one-line `collections` config.
 */
const modes: [string, (verdict?: 'accept' | 'reject') => Promise<PhotonClient>][] = [
  ['engine-native', (verdict) => client(engineTransport(verdict))],
  [
    'rest-backed',
    (verdict) =>
      client(undefined, {
        collections: { issues: { mode: 'rest-backed', resource: issuesResource(verdict).resource } },
      }),
  ],
  [
    'passthrough',
    (verdict) =>
      client(undefined, {
        collections: { issues: { mode: 'passthrough', resource: issuesResource(verdict).resource } },
      }),
  ],
]

describe.each(modes)('collection mode: %s', (name, makeClient) => {
  it('reflects the write optimistically and then confirms it', async () => {
    const photon = await makeClient()
    const handle = photon.upsert('issues', 'r1', { id: 'r1', title: 'a' })

    expect(handle.optimistic?.value).toMatchObject({ title: 'a' })
    expect(handle.optimistic?.pending).toBe(true)

    await handle.local
    await photon.sync.syncNow('manual')
    await handle.settled

    const query = photon.query({ collection: 'issues' })
    await query.ready()
    await tick()
    expect(query.getSnapshot().data[0]?.pending).toBe(false)
    query.destroy()
  })

  it('rolls the record back when the server refuses', async () => {
    const photon = await makeClient('reject')
    const handle = photon.upsert('issues', 'r1', { id: 'r1', title: 'a' })
    await handle.local

    await photon.sync.syncNow('manual')
    const result = await handle.settled
    expect(result.status).toBe('rejected')

    await tick()
    // Replaying the accepted operations of a record with none leaves nothing.
    expect(photon.query({ collection: 'issues' }).getSnapshot().data).toHaveLength(0)
  })

  it('queues writes made while offline and drains them on the next sync', async () => {
    if (name === 'passthrough') return // no queue is the mode's contract

    const photon = await makeClient()
    photon.upsert('issues', 'r1', { id: 'r1', title: 'a' })
    photon.patch('issues', 'r1', { title: 'b' })
    expect(photon.pendingCount()).toBe(2)

    await photon.sync.syncNow('manual')
    expect(photon.pendingCount()).toBe(0)
  })
})

describe('passthrough specifics', () => {
  it('pushes inline, without the sync loop', async () => {
    const { resource, rows } = issuesResource()
    const photon = await client(undefined, {
      collections: { issues: { mode: 'passthrough', resource } },
    })

    const handle = photon.upsert('issues', 'r1', { id: 'r1', title: 'inline' })
    const result = await handle.settled

    // No syncNow anywhere: the write reached the REST backend on its own.
    expect(result.status).toBe('accepted')
    expect(rows.get('r1')).toMatchObject({ title: 'inline' })
    expect(photon.pendingCount()).toBe(0)
  })

  it('never writes operations to local storage', async () => {
    const storage = memoryStore()
    const commit = vi.spyOn(storage, 'commit')
    const { resource } = issuesResource()
    const photon = await client(undefined, {
      collections: { issues: { mode: 'passthrough', resource } },
      storage,
    })

    await photon.upsert('issues', 'r1', { id: 'r1', title: 'ephemeral' }).settled

    for (const call of commit.mock.calls) {
      expect(call[0].operations ?? []).toHaveLength(0)
    }
  })

  it('rejects and restores the previous value when the backend is unreachable', async () => {
    const { resource, rows } = issuesResource()
    rows.set('r1', { id: 'r1', title: 'server value' })
    const broken = {
      ...resource,
      update: async () => {
        throw new Error('network down') // no HTTP status: a transport failure
      },
    } as unknown as RestResource<never>

    const photon = await client(undefined, {
      collections: { issues: { mode: 'passthrough', resource: broken } },
    })
    // Seed the local projection with the server value first.
    await photon.sync.syncNow('manual')
    await tick()

    const handle = photon.patch('issues', 'r1', { title: 'my edit' })
    const result = await handle.settled
    expect(result.status).toBe('rejected')

    await tick()
    const query = photon.query<{ title: string }>({ collection: 'issues' })
    await query.ready()
    await tick()
    expect(query.getSnapshot().data[0]?.value.title).toBe('server value')
    query.destroy()
  })

  it('refuses a passthrough collection without a resource', async () => {
    await expect(
      client(undefined, {
        collections: { issues: { mode: 'passthrough' } as never },
      }),
    ).rejects.toThrow(/no REST resource/)
  })
})

describe('rest-backed specifics', () => {
  it('swaps in the id the server assigned', async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const create = vi.fn(async (value: Record<string, unknown>) => {
      const row = { ...value, id: 'server-1' }
      rows.set('server-1', row)
      return row
    })
    const photon = await client(
      createRestTransport({
        resources: {
          issues: {
            list: async () => ({ items: [...rows.values()], complete: true }),
            create,
            update: async () => undefined,
            remove: async () => undefined,
            toRecord: (item: { id: string }) => ({ recordId: item.id, value: item }),
          } as never,
        },
      }),
    )

    const handle = photon.upsert('issues', 'local-temp', { title: 'a' })
    await handle.local
    await photon.sync.syncNow('manual')
    await tick()

    const query = photon.query({ collection: 'issues' })
    await query.ready()
    await tick()

    const rowsSeen = query.getSnapshot().data
    expect(rowsSeen).toHaveLength(1)
    expect(rowsSeen[0]?.key.record_id).toBe('server-1')
    expect(rowsSeen[0]?.aliasOf).toBe('local-temp')
    query.destroy()
  })

  it('does not let a refetch erase an unacknowledged local edit', async () => {
    // The server has not decided on our write yet, and meanwhile a listing
    // arrives with its older value. Losing the user's in-flight edit to that
    // refetch is the classic way this goes wrong.
    const photon = await client({
      async push() {
        return { decisions: [] }
      },
      async pull() {
        return {
          kind: 'snapshot',
          collection: 'issues',
          records: [{ collection: 'issues', recordId: 'r1', value: { id: 'r1', title: 'from server' } }],
          complete: true,
        }
      },
    })

    photon.upsert('issues', 'r1', { id: 'r1', title: 'my unsaved edit' })
    await photon.sync.syncNow('manual')
    await tick()

    const query = photon.query<{ title: string }>({ collection: 'issues' })
    await query.ready()
    await tick()
    expect(query.getSnapshot().data[0]?.value.title).toBe('my unsaved edit')
    query.destroy()
  })
})

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}
