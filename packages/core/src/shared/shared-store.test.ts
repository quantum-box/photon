/**
 * Several contexts, one store.
 *
 * Runs real `SharedStore` instances against an in-process bus and a queued
 * fake election, so ownership, promotion, and the write fan-out are exercised
 * without a browser. The transports these stand in for — BroadcastChannel and
 * Web Locks — are thin enough that their own behaviour is not what breaks.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSharedLocalStore, type SharedLocalStore } from './shared-store.js'
import type { Election } from './election.js'
import type { StoreChannel, StoreMessage } from './protocol.js'
import type { CursorRow, LocalStore, StoreWrite } from '../store.js'
import type { Collection, EngineRecord, OperationStatus } from '../types.js'

// --- a bus that behaves like BroadcastChannel: everyone but the sender ------

function createBus() {
  const peers = new Set<(message: StoreMessage) => void>()
  return {
    channel(): StoreChannel {
      const listeners = new Set<(message: StoreMessage) => void>()
      const deliver = (message: StoreMessage): void => {
        for (const listener of [...listeners]) listener(message)
      }
      peers.add(deliver)
      return {
        post(message) {
          for (const peer of [...peers]) {
            if (peer !== deliver) peer(message)
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close() {
          peers.delete(deliver)
          listeners.clear()
        },
      }
    },
  }
}

// --- an election that hands ownership down a queue, like a Web Lock --------

function createElectionQueue() {
  const queue: (() => void)[] = []
  let held = false

  const grantNext = (): void => {
    const next = queue.shift()
    if (!next) {
      held = false
      return
    }
    held = true
    next()
  }

  return {
    elect(_name: string, onWin: () => void): Election {
      let owner = false
      const win = (): void => {
        owner = true
        onWin()
      }
      if (!held) {
        held = true
        win()
      } else {
        queue.push(win)
      }
      return {
        get isOwner() {
          return owner
        },
        close() {
          const queued = queue.indexOf(win)
          if (queued >= 0) {
            queue.splice(queued, 1)
            return
          }
          if (owner) {
            owner = false
            grantNext()
          }
        },
      }
    },
  }
}

// --- the one real store the contexts share --------------------------------

function memoryStore(): LocalStore & {
  writes: StoreWrite[]
  opened: number
  lifecycle: string[]
} {
  const records = new Map<string, EngineRecord>()
  const state = {
    writes: [] as StoreWrite[],
    opened: 0,
    lifecycle: [] as string[],
    async migrate() {},
    async loadRecords() {
      return [...records.values()]
    },
    async loadPendingOperations() {
      return []
    },
    async loadAcceptedOperations() {
      return []
    },
    async loadOperationIds() {
      return []
    },
    async loadConflicts() {
      return []
    },
    async getCursor(): Promise<CursorRow | null> {
      return null
    },
    async commit(write: StoreWrite) {
      state.writes.push(write)
      for (const record of write.records ?? []) {
        records.set(`${record.key.collection}/${record.key.record_id}`, record)
      }
    },
    async stats() {
      return {
        operations: {} as Record<OperationStatus, number>,
        recordsByCollection: {} as Record<Collection, number>,
      }
    },
    raw() {
      return 'the-handle'
    },
    async close() {
      state.lifecycle.push('close')
    },
  }
  return state
}

function record(id: string, value: unknown): EngineRecord {
  return {
    key: { scope: 'workspace:test', collection: 'notes', record_id: id },
    value,
    version: { wall_time_ms: 1, counter: 0, actor_id: 'a' },
    field_versions: {},
    deleted_at: null,
    updated_by: 'a',
  }
}

async function makeContexts(count: number): Promise<{
  contexts: SharedLocalStore[]
  store: ReturnType<typeof memoryStore>
}> {
  const bus = createBus()
  const election = createElectionQueue()
  const store = memoryStore()

  const contexts: SharedLocalStore[] = []
  for (let i = 0; i < count; i += 1) {
    contexts.push(
      await createSharedLocalStore({
        key: 'test',
        channel: bus.channel(),
        elect: election.elect,
        ownershipGraceMs: 50,
        retryIntervalMs: 5,
        requestTimeoutMs: 500,
        open: async () => {
          store.opened += 1
          store.lifecycle.push('open')
          return store
        },
      }),
    )
  }
  return { contexts, store }
}

describe('shared local store', () => {
  it('opens the real store in exactly one context', async () => {
    const { contexts, store } = await makeContexts(3)

    expect(store.opened).toBe(1)
    expect(contexts.map((context) => context.isOwner)).toEqual([true, false, false])

    await Promise.all(contexts.map((context) => context.close()))
  })

  it('serves a follower read from the owner', async () => {
    const { contexts } = await makeContexts(2)
    const [owner, follower] = contexts as [SharedLocalStore, SharedLocalStore]

    await owner.commit({ records: [record('n1', { title: 'from the owner' })] })

    await expect(follower.loadRecords('workspace:test')).resolves.toEqual([
      expect.objectContaining({ value: { title: 'from the owner' } }),
    ])

    await Promise.all(contexts.map((context) => context.close()))
  })

  it("applies a follower's commit to the one real store", async () => {
    const { contexts, store } = await makeContexts(2)
    const [, follower] = contexts as [SharedLocalStore, SharedLocalStore]

    await follower.commit({ records: [record('n2', { title: 'from a follower' })] })

    expect(store.writes).toHaveLength(1)
    expect(store.opened).toBe(1)

    await Promise.all(contexts.map((context) => context.close()))
  })

  it('delivers a write to every context except the one that made it', async () => {
    const { contexts } = await makeContexts(3)
    const [owner, followerA, followerB] = contexts as [
      SharedLocalStore,
      SharedLocalStore,
      SharedLocalStore,
    ]

    const seen = [vi.fn(), vi.fn(), vi.fn()] as const
    owner.subscribe(seen[0])
    followerA.subscribe(seen[1])
    followerB.subscribe(seen[2])

    await owner.commit({ records: [record('n3', { by: 'owner' })] })
    expect(seen[0]).not.toHaveBeenCalled()
    expect(seen[1]).toHaveBeenCalledTimes(1)
    expect(seen[2]).toHaveBeenCalledTimes(1)

    await followerA.commit({ records: [record('n4', { by: 'follower-a' })] })
    // The owner applied it, so it hears about it like anyone else.
    expect(seen[0]).toHaveBeenCalledTimes(1)
    expect(seen[1]).toHaveBeenCalledTimes(1) // still just the owner's write
    expect(seen[2]).toHaveBeenCalledTimes(2)

    await Promise.all(contexts.map((context) => context.close()))
  })

  it('promotes a follower when the owner closes, and it opens the store for real', async () => {
    const { contexts, store } = await makeContexts(2)
    const [owner, follower] = contexts as [SharedLocalStore, SharedLocalStore]

    const promoted = new Promise<void>((resolve) => {
      follower.onOwnershipChange(() => resolve())
    })

    await owner.close()
    await promoted

    expect(follower.isOwner).toBe(true)
    expect(store.opened).toBe(2)
    // Two connections on one data directory is the corruption this exists to
    // prevent, so the old owner must be fully closed before the new one opens.
    expect(store.lifecycle).toEqual(['open', 'close', 'open'])

    // And it can serve itself now that nobody else is listening.
    await follower.commit({ records: [record('n5', { after: 'promotion' })] })
    expect(store.writes).toHaveLength(1)

    await follower.close()
  })

  it('answers a request that was posted before any owner was serving', async () => {
    const bus = createBus()
    const election = createElectionQueue()
    const store = memoryStore()

    let releaseOpen!: () => void
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })

    // The owner is elected but its database takes a while to open, so the
    // follower's first request lands while nobody can serve it.
    const owner = await createSharedLocalStore({
      key: 'slow',
      channel: bus.channel(),
      elect: election.elect,
      ownershipGraceMs: 5,
      open: async () => {
        await opening
        return store
      },
    })

    const follower = await createSharedLocalStore({
      key: 'slow',
      channel: bus.channel(),
      elect: election.elect,
      ownershipGraceMs: 5,
      retryIntervalMs: 5,
      requestTimeoutMs: 1_000,
      open: async () => store,
    })

    const pending = follower.loadRecords('workspace:test')
    releaseOpen()

    await expect(pending).resolves.toEqual([])
    expect(owner.isOwner).toBe(true)

    await follower.close()
    await owner.close()
  })

  it('waits out an owner that is slow to open, rather than failing the request', async () => {
    const bus = createBus()
    const election = createElectionQueue()
    const store = memoryStore()

    // The owner takes far longer to open than a single request is allowed to
    // go unanswered. On CI hardware a cold PGlite start really does run this
    // much longer than the silence budget.
    const owner = await createSharedLocalStore({
      key: 'slow-open',
      channel: bus.channel(),
      elect: election.elect,
      ownershipGraceMs: 5,
      open: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return store
      },
    })

    const follower = await createSharedLocalStore({
      key: 'slow-open',
      channel: bus.channel(),
      elect: election.elect,
      ownershipGraceMs: 5,
      retryIntervalMs: 10,
      requestTimeoutMs: 100,
      open: async () => store,
    })

    await expect(follower.loadRecords('workspace:test')).resolves.toEqual([])
    expect(owner.isOwner).toBe(true)

    await follower.close()
    await owner.close()
  })

  it('fails a request when no owner exists at all', async () => {
    const bus = createBus()
    const store = memoryStore()

    // An election that never grants: nobody is coming, so silence really does
    // mean absence and the request must not hang forever.
    const neverElected = (): Election => ({ isOwner: false, close() {} })

    const orphan = await createSharedLocalStore({
      key: 'orphan',
      channel: bus.channel(),
      elect: neverElected,
      ownershipGraceMs: 5,
      retryIntervalMs: 10,
      requestTimeoutMs: 60,
      open: async () => store,
    })

    await expect(orphan.loadRecords('workspace:test')).rejects.toThrow(
      /no shared store owner answered/,
    )

    await orphan.close()
  })

  it('gives a follower no raw handle, rather than a fake one', async () => {
    const { contexts } = await makeContexts(2)
    const [owner, follower] = contexts as [SharedLocalStore, SharedLocalStore]

    expect(owner.raw()).toBe('the-handle')
    expect(follower.raw()).toBeNull()

    await Promise.all(contexts.map((context) => context.close()))
  })

  it('surfaces an owner-side failure to the follower that caused it', async () => {
    const { contexts, store } = await makeContexts(2)
    const [, follower] = contexts as [SharedLocalStore, SharedLocalStore]

    store.commit = async () => {
      throw new Error('disk is full')
    }

    await expect(follower.commit({ records: [record('n6', {})] })).rejects.toThrow('disk is full')

    await Promise.all(contexts.map((context) => context.close()))
  })
})
