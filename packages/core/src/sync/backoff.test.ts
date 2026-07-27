import { describe, expect, it } from 'vitest'

import { createBackoff } from './backoff.js'

describe('createBackoff', () => {
  it('grows geometrically and clamps at the ceiling', () => {
    const backoff = createBackoff({ initialMs: 1000, maxMs: 30_000, jitter: 0 })
    expect(backoff.next()).toBe(1000)
    expect(backoff.next()).toBe(2000)
    expect(backoff.next()).toBe(4000)
    for (let i = 0; i < 10; i += 1) backoff.next()
    expect(backoff.next()).toBe(30_000)
  })

  it('resets back to the initial delay', () => {
    const backoff = createBackoff({ initialMs: 1000, jitter: 0 })
    backoff.next()
    backoff.next()
    backoff.reset()
    expect(backoff.attempts).toBe(0)
    expect(backoff.next()).toBe(1000)
  })

  it('spreads retries so N tabs do not reconnect in lockstep', () => {
    // Without jitter every client that lost the same server blip retries at the
    // same millisecond and recreates the outage.
    const low = createBackoff({ initialMs: 1000, jitter: 0.5, random: () => 0 })
    const high = createBackoff({ initialMs: 1000, jitter: 0.5, random: () => 1 })
    expect(low.next()).toBe(750)
    expect(high.next()).toBe(1250)
  })

  it('never returns a negative delay', () => {
    const backoff = createBackoff({ initialMs: 10, jitter: 1, random: () => 0 })
    expect(backoff.next()).toBeGreaterThanOrEqual(0)
  })

  it('reports the last delay without advancing', () => {
    const backoff = createBackoff({ initialMs: 1000, jitter: 0 })
    expect(backoff.current()).toBeNull()
    const first = backoff.next()
    expect(backoff.current()).toBe(first)
    expect(backoff.current()).toBe(first)
  })
})
