import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import * as Y from 'yjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseRecord } from '../data/mock'

const mocks = vi.hoisted(() => {
  class MockYMap {
    values = new globalThis.Map<string, string>()

    get(key: string) {
      return this.values.get(key)
    }

    set(key: string, value: string) {
      this.values.set(key, value)
      return this
    }
  }

  class MockYArray {
    items: Array<{ get: (key: string) => string | undefined; set: (key: string, value: string) => unknown }> = []

    get length() {
      return this.items.length
    }

    get(index: number) {
      return this.items[index]
    }

    push(values: Array<{ get: (key: string) => string | undefined; set: (key: string, value: string) => unknown }>) {
      this.items.push(...values)
    }

    delete(index: number, count = 1) {
      this.items.splice(index, count)
    }

    forEach(
      callback: (
        value: { get: (key: string) => string | undefined; set: (key: string, value: string) => unknown },
        index: number
      ) => void
    ) {
      this.items.forEach(callback)
    }

    clear() {
      this.items = []
    }
  }

  return {
    recordsArray: new MockYArray(),
    MockYMap,
    transact: vi.fn((fn: () => void) => fn()),
    fetchServerRecords: vi.fn(),
    createServerRecord: vi.fn(),
    updateServerRecord: vi.fn(),
    deleteServerRecord: vi.fn(),
  }
})

vi.mock('yjs', () => ({
  Map: mocks.MockYMap,
}))

vi.mock('../lib/yjs/yjsProvider', () => ({
  ydoc: {
    transact: mocks.transact,
  },
  recordsArray: mocks.recordsArray,
}))

vi.mock('../lib/yjs/useYjsRecords', () => ({
  useYjsRecords: () => ({ records: [], ready: true }),
}))

vi.mock('../lib/recordsApi', () => ({
  // No bootstrap seed runs under test, so this resolves immediately.
  playgroundSeedSettled: () => Promise.resolve(),
  fetchServerRecords: mocks.fetchServerRecords,
  createServerRecord: mocks.createServerRecord,
  updateServerRecord: mocks.updateServerRecord,
  deleteServerRecord: mocks.deleteServerRecord,
}))

import { RecordsProvider, useRecords, type CreateRecordData } from './RecordsContext'

const serverDatabaseRecord: DatabaseRecord = {
  id: 'record-server-1',
  identifier: 'PLT-1201',
  title: 'Server accepted record',
  status: 'todo',
  priority: 'none',
  assignee: null,
  labels: ['sync'],
  project: 'Photon Core',
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  description: 'Persisted by the canonical record API.',
}

function never<T>() {
  return new Promise<T>(() => undefined)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function seedYDatabaseRecord(record: DatabaseRecord) {
  const ymap = new Y.Map<string>()
  ymap.set('id', record.id)
  ymap.set('identifier', record.identifier)
  ymap.set('title', record.title)
  ymap.set('status', record.status)
  ymap.set('priority', record.priority)
  ymap.set('assignee', record.assignee ?? '')
  ymap.set('labels', JSON.stringify(record.labels))
  ymap.set('project', record.project)
  ymap.set('createdAt', record.createdAt)
  ymap.set('updatedAt', record.updatedAt)
  ymap.set('description', record.description)
  mocks.recordsArray.push([ymap])
}

function Probe({ action }: { action: (context: ReturnType<typeof useRecords>) => void }) {
  const context = useRecords()

  useEffect(() => {
    action(context)
  }, [action, context])

  return null
}

describe('RecordsProvider server-accepted projection', () => {
  beforeEach(() => {
    mocks.recordsArray.clear()
    mocks.transact.mockClear()
    mocks.fetchServerRecords.mockReset().mockReturnValue(never<DatabaseRecord[]>())
    mocks.createServerRecord.mockReset()
    mocks.updateServerRecord.mockReset()
    mocks.deleteServerRecord.mockReset()
  })

  it('writes created records optimistically and replaces them with the server version', async () => {
    const create = deferred<DatabaseRecord>()
    mocks.createServerRecord.mockReturnValue(create.promise)
    const createData: CreateRecordData = {
      title: 'Create through server',
      project: 'Photon Core',
    }

    render(
      <RecordsProvider>
        <Probe action={(context) => context.handleCreateRecord(createData)} />
      </RecordsProvider>
    )

    await waitFor(() => expect(mocks.createServerRecord).toHaveBeenCalled())
    expect(mocks.recordsArray.length).toBe(1)
    expect(mocks.recordsArray.get(0).get('id')).toContain('optimistic-record-')
    expect(mocks.recordsArray.get(0).get('title')).toBe(createData.title)

    await act(async () => {
      create.resolve(serverDatabaseRecord)
      await create.promise
    })

    expect(mocks.transact).toHaveBeenCalledTimes(2)
    expect(mocks.recordsArray.length).toBe(1)
    expect(mocks.recordsArray.get(0).get('id')).toBe(serverDatabaseRecord.id)
  })

  it('removes the optimistic created record when persistence fails', async () => {
    const create = deferred<DatabaseRecord>()
    mocks.createServerRecord.mockReturnValue(create.promise)

    render(
      <RecordsProvider>
        <Probe
          action={(context) => {
            void context.handleCreateRecord({ title: 'Rejected record' }).catch(() => undefined)
          }}
        />
      </RecordsProvider>
    )

    await waitFor(() => expect(mocks.createServerRecord).toHaveBeenCalled())
    expect(mocks.recordsArray.length).toBe(1)

    await act(async () => {
      create.reject(new Error('failed'))
      await create.promise.catch(() => undefined)
    })

    expect(mocks.recordsArray.length).toBe(0)
  })

  it('does not patch Yjs until the server returns the accepted record version', async () => {
    const update = deferred<DatabaseRecord>()
    mocks.updateServerRecord.mockReturnValue(update.promise)

    render(
      <RecordsProvider>
        <Probe
          action={(context) =>
            context.handleUpdateRecord(serverDatabaseRecord.id, 'title', 'Accepted title')
          }
        />
      </RecordsProvider>
    )

    await waitFor(() => expect(mocks.updateServerRecord).toHaveBeenCalled())
    expect(mocks.updateServerRecord).toHaveBeenCalledWith(serverDatabaseRecord.id, {
      title: 'Accepted title',
    })
    expect(mocks.transact).not.toHaveBeenCalled()
    expect(mocks.recordsArray.length).toBe(0)

    await act(async () => {
      update.resolve({ ...serverDatabaseRecord, title: 'Accepted title' })
      await update.promise
    })

    expect(mocks.recordsArray.length).toBe(1)
    expect(mocks.recordsArray.get(0).get('title')).toBe('Accepted title')
  })

  it('keeps a deleted record in Yjs until server deletion succeeds', async () => {
    const deletion = deferred<void>()
    mocks.deleteServerRecord.mockReturnValue(deletion.promise)
    seedYDatabaseRecord(serverDatabaseRecord)

    render(
      <RecordsProvider>
        <Probe action={(context) => context.handleDeleteRecord(serverDatabaseRecord.id)} />
      </RecordsProvider>
    )

    await waitFor(() => expect(mocks.deleteServerRecord).toHaveBeenCalledWith(serverDatabaseRecord.id))
    expect(mocks.recordsArray.length).toBe(1)

    await act(async () => {
      deletion.resolve()
      await deletion.promise
    })

    expect(mocks.recordsArray.length).toBe(0)
  })
})
