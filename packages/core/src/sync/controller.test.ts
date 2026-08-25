/**
 * The realtime pull hint.
 *
 * A Live frame is a doorbell: it may carry a cursor, never operations. These
 * tests pin the contract around `notifyRemoteChange` — same debounce as local
 * mutations, single-flight against a running cycle, skip when the hint is
 * behind our cursor, and polling untouched as the no-realtime safety net.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SyncEngine } from './controller.js'
import type { SyncEngineOptions } from './controller.js'
import type { LocalStore } from '../store.js'
import type { PullRequest, PullResult, SyncTransport } from './types.js'

const PUSH_DEBOUNCE_MS = 150
const POLL_INTERVAL_MS = 30_000

interface Harness {
  readonly engine: SyncEngine
  readonly pulls: PullRequest[]
  setServerCursor(position: number): void
}

function makeHarness(overrides: Partial<SyncEngineOptions> = {}): Harness {
  const pulls: PullRequest[] = []
  let serverCursor = 0
  let storedCursor: number | null = null

  const transport: SyncTransport = {
    async push() {
      return { decisions: [] }
    },
    async pull(request) {
      pulls.push(request)
      const result: PullResult = {
        kind: 'operations',
        operations: [],
        cursor: serverCursor,
        hasMore: false,
      }
      return result
    },
  }

  // Only the store surface the sync loop touches: cursor reads and commits.
  const store = {
    async getCursor() {
      return storedCursor === null
        ? null
        : { scope: 'workspace:test', remote: 'server', position: storedCursor, updatedAtMs: 0 }
    },
    async commit(write: { cursor?: { position: number } }) {
      if (write.cursor) storedCursor = write.cursor.position
    },
  } as unknown as LocalStore

  const engine = new SyncEngine({
    scope: 'workspace:test',
    transport,
    store,
    clock: () => Date.now(),
    remoteId: 'server',
    pushDebounceMs: PUSH_DEBOUNCE_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    pullPageSize: 100,
    collectPending: () => [],
    onDecision: () => {},
    applyRemote: () => [],
    applySnapshot: () => {},
    knownOperationIds: () => new Set(),
    pendingCount: () => 0,
    conflictCount: () => 0,
    ...overrides,
  })

  return {
    engine,
    pulls,
    setServerCursor(position: number) {
      serverCursor = position
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  // vi.advanceTimersByTimeAsync drives timers, but the sync cycle's own
  // promise chain still needs draining between assertions.
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('notifyRemoteChange', () => {
  let harness: Harness

  beforeEach(async () => {
    vi.useFakeTimers()
    harness = makeHarness()
    harness.engine.start()
    // Let the startup cycle finish so later assertions count only hint pulls.
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    harness.pulls.length = 0
  })

  afterEach(() => {
    harness.engine.stop()
    vi.useRealTimers()
  })

  it('debounces a burst of frames into one pull', async () => {
    harness.setServerCursor(5)
    harness.engine.notifyRemoteChange({ cursor: 3 })
    harness.engine.notifyRemoteChange({ cursor: 4 })
    harness.engine.notifyRemoteChange({ cursor: 5 })

    expect(harness.pulls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(harness.pulls).toHaveLength(1)
  })

  it('pulls when the hint cursor is ahead of the local cursor', async () => {
    harness.setServerCursor(7)
    harness.engine.notifyRemoteChange({ cursor: 7 })
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS)
    await flushMicrotasks()

    expect(harness.pulls).toHaveLength(1)
    expect(harness.engine.getStatus().cursor).toBe(7)
  })

  it('skips the pull when the hint is at or behind the local cursor', async () => {
    // First hint advances the local cursor to 7.
    harness.setServerCursor(7)
    harness.engine.notifyRemoteChange({ cursor: 7 })
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS)
    await flushMicrotasks()
    harness.pulls.length = 0

    // The echo of work we already synced: nothing scheduled at all.
    harness.engine.notifyRemoteChange({ cursor: 7 })
    harness.engine.notifyRemoteChange({ cursor: 3 })
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    await flushMicrotasks()

    expect(harness.pulls).toHaveLength(0)
  })

  it('still pulls on a hint without a cursor', async () => {
    harness.engine.notifyRemoteChange()
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS)
    await flushMicrotasks()

    expect(harness.pulls).toHaveLength(1)
  })

  it('is a no-op after stop()', async () => {
    harness.engine.stop()
    harness.engine.notifyRemoteChange({ cursor: 99 })
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    await flushMicrotasks()

    expect(harness.pulls).toHaveLength(0)
  })

  it('keeps polling as the safety net while realtime is not connected', async () => {
    harness.engine.setRealtimeState('disconnected')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(harness.pulls.length).toBeGreaterThanOrEqual(1)
  })

  it('stands the poll timer down while realtime is connected', async () => {
    harness.engine.setRealtimeState('connected')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await flushMicrotasks()

    expect(harness.pulls).toHaveLength(0)
  })
})
