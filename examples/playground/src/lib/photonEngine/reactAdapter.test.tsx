/**
 * Regression surface for `@quantum-box/photon-react` against the real dist
 * build, under <StrictMode> — the mode the playground actually runs in.
 *
 * StrictMode runs subscription setup twice on one component instance
 * (setup → cleanup → setup). The adapter once created its live query per
 * mount and destroyed it in cleanup, so the second setup re-subscribed a
 * destroyed query: unhooked from invalidation, frozen on its last snapshot.
 * The symptom was a records table stuck on whatever had loaded first.
 */
import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PhotonProvider, useLiveQuery } from '@quantum-box/photon-react'
import type { LiveQuery, PhotonClient, PhotonRecord, QueryState } from '@quantum-box/photon-core'

type RecordList = PhotonRecord<{ title: string }>[]

class FakeQuery implements LiveQuery<RecordList> {
  private listeners = new Set<() => void>()
  private destroyed = false
  private snapshot: QueryState<RecordList> = {
    data: [],
    status: 'ready',
    error: null,
    pending: false,
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

  invalidate(records: RecordList) {
    if (this.destroyed) return
    this.snapshot = { ...this.snapshot, data: records }
    for (const listener of this.listeners) listener()
  }
}

function makeFakeEngine() {
  const queries: FakeQuery[] = []
  let records: RecordList = []

  const client = {
    query: () => {
      const query = new FakeQuery()
      queries.push(query)
      query.invalidate(records)
      return query
    },
  } as unknown as PhotonClient

  return {
    client,
    insert(record: RecordList[number]) {
      records = [...records, record]
      for (const query of queries) {
        query.invalidate(records)
      }
    },
  }
}

function RecordCount() {
  const query = useLiveQuery<{ title: string }>({ collection: 'records' })
  return <div data-testid="count">{query.data.length}</div>
}

describe('useLiveQuery under StrictMode', () => {
  it('keeps receiving updates after the double-invoked subscription cycle', () => {
    const engine = makeFakeEngine()

    render(
      <StrictMode>
        <PhotonProvider client={engine.client}>
          <RecordCount />
        </PhotonProvider>
      </StrictMode>
    )

    expect(screen.getByTestId('count').textContent).toBe('0')

    act(() => {
      engine.insert({ value: { title: 'first' } } as RecordList[number])
    })
    expect(screen.getByTestId('count').textContent).toBe('1')

    act(() => {
      engine.insert({ value: { title: 'second' } } as RecordList[number])
    })
    expect(screen.getByTestId('count').textContent).toBe('2')
  })
})
