/**
 * End-to-end through the real stack: real WASM kernel, real PGlite, real
 * transport. Nothing is mocked except the network.
 *
 * This is the test that used to run against a hand-written stub which threw on
 * every call, so it proved nothing about the engine at all.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  deleteClientEngineRecord,
  getClientEngineRecord,
  listClientEngineRecords,
  patchClientEngineRecord,
  photonClient,
  syncClientEngineOperations,
  upsertClientEngineRecord,
} from './client'

describe('the playground engine client', () => {
  it('round-trips records through the kernel and durable storage', async () => {
    const collection = `test_records_${Date.now()}`

    const created = await upsertClientEngineRecord(collection, 'record-1', {
      title: 'Local first',
      status: 'todo',
    })
    expect(created.value).toMatchObject({ title: 'Local first', status: 'todo' })

    // The patch carries only the changed field and the kernel merges it, so
    // `title` survives without being resent.
    const patched = await patchClientEngineRecord(collection, 'record-1', { status: 'done' })
    expect(patched?.value).toMatchObject({ title: 'Local first', status: 'done' })

    await expect(getClientEngineRecord(collection, 'record-1')).resolves.toMatchObject({
      value: { title: 'Local first', status: 'done' },
    })
    await expect(listClientEngineRecords(collection)).resolves.toHaveLength(1)

    await deleteClientEngineRecord(collection, 'record-1')
    await expect(getClientEngineRecord(collection, 'record-1')).resolves.toBeNull()
    await expect(listClientEngineRecords(collection)).resolves.toHaveLength(0)
  }, 30_000)

  it('reflects a mutation synchronously, before any await', async () => {
    const client = await photonClient()
    const collection = `test_optimistic_${Date.now()}`
    const id = client.newId('rec')

    const handle = client.upsert(collection, id, { title: 'instant' })

    // The whole point of the engine: all three are true before the durable
    // write, before the network, before the next tick.
    expect(handle.optimistic?.value).toEqual({ title: 'instant' })
    expect(handle.optimistic?.pending).toBe(true)
    expect(handle.optimistic?.durable).toBe(false)

    await handle.local
    expect((await getClientEngineRecord(collection, id))?.value).toEqual({ title: 'instant' })
  }, 30_000)

  it('pushes pending operations and stops pushing once accepted', async () => {
    const collection = `test_sync_${Date.now()}`
    await upsertClientEngineRecord(collection, 'record-sync', { title: 'push me' })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/pull')) {
        return new Response(JSON.stringify({ operations: [], cursor: null }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body))
      expect(
        body.operations.every(
          (operation: { key: { scope: string } }) => operation.key.scope === body.scope,
        ),
      ).toBe(true)
      return new Response(
        JSON.stringify({
          decisions: body.operations.map((operation: { id: string }, index: number) => ({
            decision: 'accepted',
            operation_id: operation.id,
            remote_sequence: index + 1,
          })),
        }),
        { status: 200 },
      )
    })

    const synced = await syncClientEngineOperations()
    expect(synced.pushed).toBeGreaterThan(0)

    // Nothing is pending any more, so a second cycle pushes nothing.
    await expect(syncClientEngineOperations()).resolves.toMatchObject({ pushed: 0 })

    fetchMock.mockRestore()
  }, 30_000)
})
