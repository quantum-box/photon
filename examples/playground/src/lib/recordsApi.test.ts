import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appKitConfig } from '../app/kitConfig'

const engineMocks = vi.hoisted(() => ({
  deleteRecord: vi.fn(),
  getRecord: vi.fn(),
  listRecords: vi.fn(),
  patchRecord: vi.fn(),
  sync: vi.fn(),
  upsertRecord: vi.fn(),
}))

vi.mock('./photonEngine/client', () => ({
  deleteClientEngineRecord: engineMocks.deleteRecord,
  getClientEngineRecord: engineMocks.getRecord,
  listClientEngineRecords: engineMocks.listRecords,
  patchClientEngineRecord: engineMocks.patchRecord,
  syncClientEngineOperations: engineMocks.sync,
  upsertClientEngineRecord: engineMocks.upsertRecord,
}))

import { seedPlaygroundData, toRecord, type ServerRecord } from './recordsApi'

describe('recordsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('normalizes server record projections for the engine read path', () => {
    const serverRecord: ServerRecord = {
      id: 'f3cc94d8-cc78-4fd3-a407-4793ea2f537c',
      identifier: 'PLT-1200',
      title: 'Persist record writes',
      description: 'Route frontend writes through the server.',
      status: 'in_progress',
      priority: 'high',
      assignee: '',
      labels: ['Feature', 'sync'],
      project: 'Photon Core',
      created_at: '2026-05-08 03:30:00',
      updated_at: '2026-05-08 03:31:00',
    }

    expect(toRecord(serverRecord)).toEqual({
      id: 'f3cc94d8-cc78-4fd3-a407-4793ea2f537c',
      identifier: 'PLT-1200',
      title: 'Persist record writes',
      description: 'Route frontend writes through the server.',
      status: 'in_progress',
      priority: 'high',
      assignee: null,
      labels: ['Feature', 'sync'],
      project: 'Photon Core',
      createdAt: '2026-05-08 03:30:00',
      updatedAt: '2026-05-08 03:31:00',
    })
  })

  it('keeps older server rows renderable during migration', () => {
    expect(
      toRecord({
        id: 'legacy-record',
        title: 'Legacy row',
        labels: '["legacy"]',
      })
    ).toMatchObject({
      id: 'legacy-record',
      identifier: 'legacy-record',
      status: 'backlog',
      priority: 'none',
      labels: ['legacy'],
      project: appKitConfig.records.defaultProject,
    })
  })

  it('pulls the shared seed marker before seeding a fresh local store', async () => {
    engineMocks.sync.mockResolvedValue({ pushed: 0, pulled: 1 })
    engineMocks.getRecord.mockResolvedValue({
      recordId: 'default-records-v1',
      value: { seededAt: '2026-08-25T00:00:00Z', count: 205 },
    })

    await seedPlaygroundData()

    expect(engineMocks.sync).toHaveBeenCalledOnce()
    expect(engineMocks.getRecord).toHaveBeenCalledWith(
      'engine_seed',
      'default-records-v1',
      { includeDeleted: true },
    )
    expect(engineMocks.sync.mock.invocationCallOrder[0])
      .toBeLessThan(engineMocks.getRecord.mock.invocationCallOrder[0])
    expect(engineMocks.upsertRecord).not.toHaveBeenCalled()
  })
})
