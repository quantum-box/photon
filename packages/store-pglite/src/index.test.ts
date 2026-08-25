import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'

import { createPGliteStore, PGliteStoreLockedError } from './index.js'

/**
 * A faithful-enough Web Locks fake: exclusive by name, `ifAvailable`
 * semantics, held until the callback's promise settles — which is exactly
 * how the store holds its lock until `close()`.
 */
function fakeLockManager() {
  const held = new Set<string>()
  return {
    held,
    locks: {
      async request(
        name: string,
        options: { ifAvailable: boolean },
        callback: (lock: object | null) => Promise<unknown>,
      ): Promise<unknown> {
        if (held.has(name)) {
          if (options.ifAvailable) return callback(null)
          throw new Error('queueing is not modeled by this fake')
        }
        held.add(name)
        try {
          return await callback({ name })
        } finally {
          held.delete(name)
        }
      },
    },
  }
}

function fakeClient(): PGlite {
  return { close: async () => {} } as unknown as PGlite
}

// Node exposes `globalThis.navigator` as a getter-only property, so plain
// assignment throws there; `vi.stubGlobal` redefines it properly and
// `unstubAllGlobals` restores the original.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('exclusiveLock', () => {
  it('makes a second holder of the same dataDir fail loudly', async () => {
    const manager = fakeLockManager()
    vi.stubGlobal('navigator', { locks: manager.locks })

    const first = await createPGliteStore({
      dataDir: 'idb://photon-test',
      client: fakeClient(),
      exclusiveLock: true,
    })

    await expect(
      createPGliteStore({
        dataDir: 'idb://photon-test',
        client: fakeClient(),
        exclusiveLock: true,
      }),
    ).rejects.toBeInstanceOf(PGliteStoreLockedError)

    // A different directory is a different lock.
    const other = await createPGliteStore({
      dataDir: 'idb://photon-other',
      client: fakeClient(),
      exclusiveLock: true,
    })
    await other.close()
    await first.close()
  })

  it('releases the lock on close so the next holder can open', async () => {
    const manager = fakeLockManager()
    vi.stubGlobal('navigator', { locks: manager.locks })

    const first = await createPGliteStore({
      dataDir: 'idb://photon-test',
      client: fakeClient(),
      exclusiveLock: true,
    })
    await first.close()
    // close() resolves the held promise; the fake clears the name after the
    // callback settles, which needs a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const second = await createPGliteStore({
      dataDir: 'idb://photon-test',
      client: fakeClient(),
      exclusiveLock: true,
    })
    await second.close()
  })

  it('degrades to the in-process guard when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', undefined)

    const store = await createPGliteStore({
      dataDir: 'idb://photon-test',
      client: fakeClient(),
      exclusiveLock: true,
    })
    await store.close()
  })

  it('does not touch Web Locks unless asked to', async () => {
    const manager = fakeLockManager()
    vi.stubGlobal('navigator', { locks: manager.locks })

    const store = await createPGliteStore({
      dataDir: 'idb://photon-test',
      client: fakeClient(),
    })
    expect(manager.held.size).toBe(0)
    await store.close()
  })
})

describe('loadRecords filters', () => {
  function queryCapturingClient() {
    const calls: { sql: string; params: unknown[] }[] = []
    const client = {
      calls,
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params })
        return { rows: [] }
      },
      async close() {},
    }
    return client as unknown as PGlite & { calls: { sql: string; params: unknown[] }[] }
  }

  it('loads the whole scope when no filter is given', async () => {
    const client = queryCapturingClient()
    const store = await createPGliteStore({ client })

    await store.loadRecords('workspace:a')
    expect(client.calls[0]?.sql).toBe(
      'SELECT record_json FROM photon_engine_records WHERE scope = $1',
    )
    expect(client.calls[0]?.params).toEqual(['workspace:a'])
  })

  it('narrows to one collection for lazy hydration', async () => {
    const client = queryCapturingClient()
    const store = await createPGliteStore({ client })

    await store.loadRecords('workspace:a', { collection: 'records' })
    expect(client.calls[0]?.sql).toBe(
      'SELECT record_json FROM photon_engine_records WHERE scope = $1 AND collection = $2',
    )
    expect(client.calls[0]?.params).toEqual(['workspace:a', 'records'])
  })

  it('excludes lazy collections at bootstrap', async () => {
    const client = queryCapturingClient()
    const store = await createPGliteStore({ client })

    await store.loadRecords('workspace:a', { excludeCollections: ['records', 'comments'] })
    expect(client.calls[0]?.sql).toBe(
      'SELECT record_json FROM photon_engine_records WHERE scope = $1 AND collection NOT IN ($2, $3)',
    )
    expect(client.calls[0]?.params).toEqual(['workspace:a', 'records', 'comments'])
  })
})

describe('commit journal', () => {
  /**
   * A fake PGlite that records every statement. `checkpointSeq` plays the
   * role of the durable image: it is what the next boot's checkpoint read
   * returns, no matter what was "written" — exactly how a lost PGlite flush
   * behaves.
   */
  function journalClient(checkpointSeq: number) {
    const applied: { sql: string; params?: unknown[] }[] = []
    const tx = {
      async query(sql: string, params?: unknown[]) {
        applied.push({ sql, params })
        return { rows: [] }
      },
    }
    const client = {
      applied,
      async exec() {},
      async query(sql: string) {
        if (sql.includes('photon_engine_journal_checkpoint')) {
          return { rows: [{ seq: checkpointSeq }] }
        }
        return { rows: [] }
      },
      async transaction(cb: (t: typeof tx) => Promise<void>) {
        await cb(tx)
      },
      async close() {},
    }
    return client as unknown as PGlite & { applied: { sql: string; params?: unknown[] }[] }
  }

  const operation = {
    id: 'op_journal_1',
    key: { scope: 'workspace:a', collection: 'records', record_id: 'r1' },
    actor_id: 'actor',
    kind: { type: 'upsert', value: { title: 'kept' } },
  }

  it('replays journaled commits that the durable image lost', async () => {
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb')
    vi.stubGlobal('indexedDB', indexedDB)
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const dataDir = `idb://journal-replay-${Date.now()}`

    // First session: the commit lands in the journal (checkpoint says 0).
    const first = await createPGliteStore({ dataDir, client: journalClient(0) })
    await first.migrate()
    await first.commit({ operations: [operation as never] })
    await first.close()

    // Second session: PGlite comes back empty (checkpoint still 0), so the
    // journal entry must be replayed into it during migrate().
    const client = journalClient(0)
    const second = await createPGliteStore({ dataDir, client })
    await second.migrate()

    const replayedOp = client.applied.find((call) =>
      call.sql.includes('INSERT INTO photon_engine_operations'),
    )
    expect(replayedOp?.params?.[0]).toBe('op_journal_1')
    const checkpoint = client.applied.find((call) =>
      call.sql.includes('photon_engine_journal_checkpoint'),
    )
    expect(checkpoint?.params).toEqual([1])
    await second.close()
  })

  it('prunes journal entries the durable image already contains', async () => {
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb')
    vi.stubGlobal('indexedDB', indexedDB)
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const dataDir = `idb://journal-prune-${Date.now()}`

    const first = await createPGliteStore({ dataDir, client: journalClient(0) })
    await first.migrate()
    await first.commit({ operations: [operation as never] })
    await first.close()

    // This boot's durable image already covers seq 1: nothing to replay.
    const client = journalClient(1)
    const second = await createPGliteStore({ dataDir, client })
    await second.migrate()
    expect(
      client.applied.filter((call) => call.sql.includes('INSERT INTO photon_engine_operations')),
    ).toHaveLength(0)
    await second.close()
  })

  it('keeps working without a journal when IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const client = journalClient(0)
    const store = await createPGliteStore({ dataDir: 'idb://journal-none', client })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.migrate()
    await store.commit({ operations: [operation as never] })
    warn.mockRestore()

    const write = client.applied.find((call) =>
      call.sql.includes('INSERT INTO photon_engine_operations'),
    )
    expect(write?.params?.[0]).toBe('op_journal_1')
    await store.close()
  })
})
