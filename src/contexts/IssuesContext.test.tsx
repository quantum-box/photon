import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import * as Y from 'yjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Issue } from '../data/mock'

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
    issuesArray: new MockYArray(),
    MockYMap,
    transact: vi.fn((fn: () => void) => fn()),
    fetchServerIssues: vi.fn(),
    createServerIssue: vi.fn(),
    updateServerIssue: vi.fn(),
    deleteServerIssue: vi.fn(),
  }
})

vi.mock('yjs', () => ({
  Map: mocks.MockYMap,
}))

vi.mock('../lib/yjs/yjsProvider', () => ({
  ydoc: {
    transact: mocks.transact,
  },
  issuesArray: mocks.issuesArray,
}))

vi.mock('../lib/yjs/useYjsIssues', () => ({
  useYjsIssues: () => ({ issues: [], ready: true }),
}))

vi.mock('../lib/issuesApi', () => ({
  fetchServerIssues: mocks.fetchServerIssues,
  createServerIssue: mocks.createServerIssue,
  updateServerIssue: mocks.updateServerIssue,
  deleteServerIssue: mocks.deleteServerIssue,
}))

import { IssuesProvider, useIssues, type CreateIssueData } from './IssuesContext'

const serverIssue: Issue = {
  id: 'issue-server-1',
  identifier: 'PLT-1201',
  title: 'Server accepted issue',
  status: 'todo',
  priority: 'none',
  assignee: null,
  labels: ['sync'],
  project: 'Photon Core',
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  description: 'Persisted by the canonical issue API.',
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

function seedYIssue(issue: Issue) {
  const ymap = new Y.Map<string>()
  ymap.set('id', issue.id)
  ymap.set('identifier', issue.identifier)
  ymap.set('title', issue.title)
  ymap.set('status', issue.status)
  ymap.set('priority', issue.priority)
  ymap.set('assignee', issue.assignee ?? '')
  ymap.set('labels', JSON.stringify(issue.labels))
  ymap.set('project', issue.project)
  ymap.set('createdAt', issue.createdAt)
  ymap.set('updatedAt', issue.updatedAt)
  ymap.set('description', issue.description)
  mocks.issuesArray.push([ymap])
}

function Probe({ action }: { action: (context: ReturnType<typeof useIssues>) => void }) {
  const context = useIssues()

  useEffect(() => {
    action(context)
  }, [action, context])

  return null
}

describe('IssuesProvider server-accepted projection', () => {
  beforeEach(() => {
    mocks.issuesArray.clear()
    mocks.transact.mockClear()
    mocks.fetchServerIssues.mockReset().mockReturnValue(never<Issue[]>())
    mocks.createServerIssue.mockReset()
    mocks.updateServerIssue.mockReset()
    mocks.deleteServerIssue.mockReset()
  })

  it('does not write created issues into Yjs until the server accepts them', async () => {
    const create = deferred<Issue>()
    mocks.createServerIssue.mockReturnValue(create.promise)
    const createData: CreateIssueData = {
      title: 'Create through server',
      project: 'Photon Core',
    }

    render(
      <IssuesProvider>
        <Probe action={(context) => context.handleCreateIssue(createData)} />
      </IssuesProvider>
    )

    await waitFor(() => expect(mocks.createServerIssue).toHaveBeenCalled())
    expect(mocks.transact).not.toHaveBeenCalled()
    expect(mocks.issuesArray.length).toBe(0)

    await act(async () => {
      create.resolve(serverIssue)
      await create.promise
    })

    expect(mocks.transact).toHaveBeenCalledTimes(1)
    expect(mocks.issuesArray.length).toBe(1)
    expect(mocks.issuesArray.get(0).get('id')).toBe(serverIssue.id)
  })

  it('does not patch Yjs until the server returns the accepted issue version', async () => {
    const update = deferred<Issue>()
    mocks.updateServerIssue.mockReturnValue(update.promise)

    render(
      <IssuesProvider>
        <Probe
          action={(context) =>
            context.handleUpdateIssue(serverIssue.id, 'title', 'Accepted title')
          }
        />
      </IssuesProvider>
    )

    await waitFor(() => expect(mocks.updateServerIssue).toHaveBeenCalled())
    expect(mocks.updateServerIssue).toHaveBeenCalledWith(serverIssue.id, {
      title: 'Accepted title',
    })
    expect(mocks.transact).not.toHaveBeenCalled()
    expect(mocks.issuesArray.length).toBe(0)

    await act(async () => {
      update.resolve({ ...serverIssue, title: 'Accepted title' })
      await update.promise
    })

    expect(mocks.issuesArray.length).toBe(1)
    expect(mocks.issuesArray.get(0).get('title')).toBe('Accepted title')
  })

  it('keeps a deleted issue in Yjs until server deletion succeeds', async () => {
    const deletion = deferred<void>()
    mocks.deleteServerIssue.mockReturnValue(deletion.promise)
    seedYIssue(serverIssue)

    render(
      <IssuesProvider>
        <Probe action={(context) => context.handleDeleteIssue(serverIssue.id)} />
      </IssuesProvider>
    )

    await waitFor(() => expect(mocks.deleteServerIssue).toHaveBeenCalledWith(serverIssue.id))
    expect(mocks.issuesArray.length).toBe(1)

    await act(async () => {
      deletion.resolve()
      await deletion.promise
    })

    expect(mocks.issuesArray.length).toBe(0)
  })
})
