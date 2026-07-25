import { describe, expect, it, vi } from 'vitest'
import {
  deleteClientEngineRecord,
  getClientEngineRecord,
  listClientEngineRecords,
  patchClientEngineRecord,
  syncClientEngineOperations,
  upsertClientEngineRecord,
} from './client'

describe('client Photon Engine', () => {
  it('stores durable records and pending operations in PGlite', async () => {
    const collection = `test_records_${Date.now()}`
    const created = await upsertClientEngineRecord(collection, 'record-1', {
      title: 'Local first',
      status: 'todo',
    })

    expect(created.value).toMatchObject({ title: 'Local first', status: 'todo' })

    const patched = await patchClientEngineRecord(collection, 'record-1', {
      status: 'done',
    })
    expect(patched?.value).toMatchObject({ title: 'Local first', status: 'done' })

    await expect(getClientEngineRecord(collection, 'record-1')).resolves.toMatchObject({
      value: { title: 'Local first', status: 'done' },
    })
    await expect(listClientEngineRecords(collection)).resolves.toHaveLength(1)

    await deleteClientEngineRecord(collection, 'record-1')
    await expect(getClientEngineRecord(collection, 'record-1')).resolves.toBeNull()
    await expect(listClientEngineRecords(collection)).resolves.toHaveLength(0)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.scope).toBe('tenant:photon:workspace:photon-default')
      expect(body.operations.every((operation: { key: { scope: string } }) =>
        operation.key.scope === body.scope
      )).toBe(true)
      return new Response(JSON.stringify({
        decisions: body.operations.map((operation: { id: string }, index: number) => ({
          type: 'accepted',
          operation_id: operation.id,
          remote_sequence: index + 1,
        })),
        server_operations: [],
        cursor: null,
      }), { status: 200 })
    })

    const synced = await syncClientEngineOperations()
    expect(synced.pushed).toBeGreaterThan(0)
    expect(synced.accepted).toBe(synced.pushed)
    await expect(syncClientEngineOperations()).resolves.toEqual({ pushed: 0, accepted: 0 })
    fetchMock.mockRestore()
  }, 30_000)
})
