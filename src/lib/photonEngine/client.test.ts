import { describe, expect, it } from 'vitest'
import {
  deleteClientEngineRecord,
  getClientEngineRecord,
  listClientEngineRecords,
  patchClientEngineRecord,
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
  }, 30_000)
})
