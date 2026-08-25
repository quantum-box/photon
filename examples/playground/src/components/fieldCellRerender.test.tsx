/**
 * Regression surface for the "one delta, one cell" contract at the view
 * level, under <StrictMode> — the mode the playground actually runs in.
 *
 * The views receive the record list for structure (row order, grouping), so
 * every engine delta hands them a fresh array and re-renders the shell. The
 * cells and cards must not follow: they carry recordId only and subscribe to
 * their own fields with useRecordField. These tests pin that a delta on one
 * field re-renders exactly the cell that shows it.
 *
 * Render counting: useRecordField is wrapped (not replaced — it delegates to
 * the real hook) so each call marks one render of the subscribing cell.
 */
import { StrictMode, useMemo } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LiveQuery, PhotonClient, PhotonRecord, QueryState } from '@quantum-box/photon-core'
import type { DatabaseRecord } from '../data/mock'

const renderCounts = vi.hoisted(() => new Map<string, number>())

vi.mock('@quantum-box/photon-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@quantum-box/photon-react')>()
  return {
    ...actual,
    useRecordField: ((collection, recordId, field) => {
      const key = `${String(recordId)}:${String(field)}`
      renderCounts.set(key, (renderCounts.get(key) ?? 0) + 1)
      return actual.useRecordField(collection, recordId, field)
    }) as typeof actual.useRecordField,
  }
})

import { PhotonProvider, useLiveQuery } from '@quantum-box/photon-react'
import { TableView } from './TableView'
import { KanbanView } from './KanbanView'

type EngineRecord = PhotonRecord<DatabaseRecord>

class FakeQuery<R> implements LiveQuery<R> {
  private listeners = new Set<() => void>()
  private destroyed = false
  private snapshot: QueryState<R>

  constructor(data: R) {
    this.snapshot = { data, status: 'ready', error: null, pending: false }
  }

  getSnapshot() {
    return this.snapshot
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  ready() {
    return Promise.resolve()
  }

  destroy() {
    // Mirrors the engine: a destroyed query drops off the invalidation feed
    // and keeps returning its last snapshot forever.
    this.destroyed = true
    this.listeners.clear()
  }

  invalidate(data: R) {
    if (this.destroyed) return
    this.snapshot = { ...this.snapshot, data }
    for (const listener of this.listeners) listener()
  }
}

function makeFakeEngine(initial: DatabaseRecord[]) {
  let values = initial
  const listQueries: FakeQuery<EngineRecord[]>[] = []
  const recordQueries = new Map<string, FakeQuery<EngineRecord | null>[]>()

  const wrap = (value: DatabaseRecord) => ({ value }) as EngineRecord

  const client = {
    query: () => {
      const query = new FakeQuery<EngineRecord[]>(values.map(wrap))
      listQueries.push(query)
      return query
    },
    liveRecord: (_collection: string, recordId: string) => {
      const value = values.find((candidate) => candidate.id === recordId)
      const query = new FakeQuery<EngineRecord | null>(value ? wrap(value) : null)
      const queries = recordQueries.get(recordId) ?? []
      queries.push(query)
      recordQueries.set(recordId, queries)
      return query
    },
  } as unknown as PhotonClient

  return {
    client,
    update(recordId: string, patch: Partial<DatabaseRecord>) {
      // The engine rebuilds `value` wholesale on any change; mirror that so
      // untouched fields still get fresh container identities.
      values = values.map((value) =>
        value.id === recordId ? { ...value, ...patch } : value
      )
      const updated = values.find((value) => value.id === recordId)
      for (const query of listQueries) query.invalidate(values.map(wrap))
      for (const query of recordQueries.get(recordId) ?? []) {
        query.invalidate(updated ? wrap(updated) : null)
      }
    },
  }
}

function makeRecord(overrides: Partial<DatabaseRecord> & { id: string }): DatabaseRecord {
  return {
    identifier: `PLT-${overrides.id}`,
    title: `Record ${overrides.id}`,
    status: 'todo',
    priority: 'medium',
    assignee: null,
    labels: [],
    project: 'Photon Core',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    description: '',
    ...overrides,
  }
}

const noop = () => {}

// jsdom lays out nothing, so the table's virtualizer sees a zero-height
// viewport (it reads offsetWidth/offsetHeight) and renders no rows. Give
// every element a real size instead.
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetWidth'
)
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
)

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1200,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 800,
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1200,
    height: 800,
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
})

afterAll(() => {
  if (originalOffsetWidth) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
  }
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  }
  vi.restoreAllMocks()
})

function LiveTableView() {
  const query = useLiveQuery<DatabaseRecord>({ collection: 'records' })
  const records = useMemo(() => query.data.map((record) => record.value), [query.data])
  return (
    <TableView
      records={records}
      selectedRecordId={null}
      onSelectRecord={noop}
      onUpdateRecord={noop}
      onCreateRecord={noop}
    />
  )
}

function LiveKanbanView() {
  const query = useLiveQuery<DatabaseRecord>({ collection: 'records' })
  const records = useMemo(() => query.data.map((record) => record.value), [query.data])
  return (
    <KanbanView
      records={records}
      selectedRecordId={null}
      onSelectRecord={noop}
      onMoveRecord={noop}
    />
  )
}

describe('TableView field cells under StrictMode', () => {
  it('re-renders only the cell whose field changed', () => {
    const engine = makeFakeEngine([
      makeRecord({ id: 'r1', title: 'First record' }),
      makeRecord({ id: 'r2', title: 'Second record', status: 'in_progress' }),
    ])
    renderCounts.clear()

    render(
      <StrictMode>
        <PhotonProvider client={engine.client}>
          <LiveTableView />
        </PhotonProvider>
      </StrictMode>
    )
    expect(screen.getByText('First record')).toBeInTheDocument()
    expect(screen.getByText('Second record')).toBeInTheDocument()
    const baseline = new Map(renderCounts)

    // A status delta on r2 must leave the other record and even the sibling
    // cells of the same row untouched.
    act(() => {
      engine.update('r2', { status: 'done' })
    })

    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(renderCounts.get('r2:status')).toBeGreaterThan(baseline.get('r2:status') ?? 0)
    expect(renderCounts.get('r2:title')).toBe(baseline.get('r2:title'))
    expect(renderCounts.get('r2:labels')).toBe(baseline.get('r2:labels'))
    expect(renderCounts.get('r1:status')).toBe(baseline.get('r1:status'))
    expect(renderCounts.get('r1:title')).toBe(baseline.get('r1:title'))
  })
})

describe('KanbanView cards under StrictMode', () => {
  it('re-renders only the card whose record changed', () => {
    const engine = makeFakeEngine([
      makeRecord({ id: 'r1', title: 'First card' }),
      makeRecord({ id: 'r2', title: 'Second card' }),
    ])
    renderCounts.clear()

    render(
      <StrictMode>
        <PhotonProvider client={engine.client}>
          <LiveKanbanView />
        </PhotonProvider>
      </StrictMode>
    )
    expect(screen.getByText('First card')).toBeInTheDocument()
    expect(screen.getByText('Second card')).toBeInTheDocument()
    const baseline = new Map(renderCounts)

    act(() => {
      engine.update('r2', { title: 'Renamed card' })
    })

    expect(screen.getByText('Renamed card')).toBeInTheDocument()
    expect(renderCounts.get('r2:title')).toBeGreaterThan(baseline.get('r2:title') ?? 0)
    expect(renderCounts.get('r1:title')).toBe(baseline.get('r1:title'))
    expect(renderCounts.get('r1:status')).toBe(baseline.get('r1:status'))
  })
})
