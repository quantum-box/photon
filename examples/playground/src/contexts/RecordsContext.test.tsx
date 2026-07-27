import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseRecord } from '../data/mock'

const mocks = vi.hoisted(() => ({
  useLiveQuery: vi.fn(),
  createServerRecord: vi.fn(),
  updateServerRecord: vi.fn(),
  deleteServerRecord: vi.fn(),
}))

vi.mock('@quantum-box/photon-react', () => ({
  useLiveQuery: mocks.useLiveQuery,
}))

vi.mock('../lib/recordsApi', () => ({
  createServerRecord: mocks.createServerRecord,
  updateServerRecord: mocks.updateServerRecord,
  deleteServerRecord: mocks.deleteServerRecord,
}))

import { RecordsProvider, useRecords, type CreateRecordData } from './RecordsContext'

const engineDatabaseRecord: DatabaseRecord = {
  id: 'record-engine-1',
  identifier: 'PLT-1201',
  title: 'Engine projected record',
  status: 'todo',
  priority: 'none',
  assignee: null,
  labels: ['sync'],
  project: 'Photon Core',
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  description: 'Served by the engine live query.',
}

function Probe({ action }: { action: (context: ReturnType<typeof useRecords>) => void }) {
  const context = useRecords()

  useEffect(() => {
    action(context)
  }, [action, context])

  return null
}

describe('RecordsProvider engine projection', () => {
  beforeEach(() => {
    mocks.useLiveQuery
      .mockReset()
      .mockReturnValue({
        data: [{ value: engineDatabaseRecord }],
        status: 'ready',
        error: null,
        pending: false,
      })
    mocks.createServerRecord.mockReset().mockResolvedValue(engineDatabaseRecord)
    mocks.updateServerRecord.mockReset().mockResolvedValue(engineDatabaseRecord)
    mocks.deleteServerRecord.mockReset().mockResolvedValue(undefined)
  })

  it('renders records straight from the engine live query', () => {
    let observed: DatabaseRecord[] = []
    let counts: Record<string, number> = {}

    render(
      <RecordsProvider>
        <Probe
          action={(context) => {
            observed = context.records
            counts = context.recordCountByStatus
          }}
        />
      </RecordsProvider>
    )

    expect(observed).toEqual([engineDatabaseRecord])
    expect(counts).toEqual({ todo: 1 })
    expect(mocks.useLiveQuery).toHaveBeenCalledWith({
      collection: 'records',
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
    })
  })

  it('creates records through the record API with playground defaults filled in', async () => {
    const createData: CreateRecordData = {
      title: 'Create through the engine',
      project: 'Photon Core',
    }

    render(
      <RecordsProvider>
        <Probe action={(context) => void context.handleCreateRecord(createData)} />
      </RecordsProvider>
    )

    await waitFor(() => expect(mocks.createServerRecord).toHaveBeenCalled())
    expect(mocks.createServerRecord).toHaveBeenCalledWith({
      title: 'Create through the engine',
      assignee: null,
      labels: [],
      project: 'Photon Core',
    })
  })

  it('maps field updates onto the server update payload', async () => {
    render(
      <RecordsProvider>
        <Probe
          action={(context) =>
            context.handleUpdateRecord(engineDatabaseRecord.id, 'labels', '["a","b"]')
          }
        />
      </RecordsProvider>
    )

    await waitFor(() =>
      expect(mocks.updateServerRecord).toHaveBeenCalledWith(engineDatabaseRecord.id, {
        labels: ['a', 'b'],
      })
    )
  })

  it('moves records by patching their status', async () => {
    render(
      <RecordsProvider>
        <Probe action={(context) => context.handleMoveRecord(engineDatabaseRecord.id, 'done')} />
      </RecordsProvider>
    )

    await waitFor(() =>
      expect(mocks.updateServerRecord).toHaveBeenCalledWith(engineDatabaseRecord.id, {
        status: 'done',
      })
    )
  })

  it('deletes records through the record API', async () => {
    render(
      <RecordsProvider>
        <Probe action={(context) => context.handleDeleteRecord(engineDatabaseRecord.id)} />
      </RecordsProvider>
    )

    await waitFor(() =>
      expect(mocks.deleteServerRecord).toHaveBeenCalledWith(engineDatabaseRecord.id)
    )
  })
})
