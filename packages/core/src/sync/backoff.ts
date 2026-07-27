/**
 * Shared reconnect/retry backoff.
 *
 * Both the sync loop and the Live WebSocket use this. They used to carry
 * separate copies with no jitter, which means after a brief server blip every
 * open tab retries in lockstep and re-creates the outage.
 */

export interface BackoffOptions {
  readonly initialMs?: number
  readonly maxMs?: number
  readonly factor?: number
  /** Fraction of the delay to randomize, 0–1. Zero only for tests. */
  readonly jitter?: number
  readonly random?: () => number
}

export interface Backoff {
  /** Delay for the next attempt, advancing the sequence. */
  next(): number
  /** Delay the last `next()` returned, without advancing. */
  current(): number | null
  reset(): void
  readonly attempts: number
}

export function createBackoff(options: BackoffOptions = {}): Backoff {
  const initialMs = options.initialMs ?? 1_000
  const maxMs = options.maxMs ?? 30_000
  const factor = options.factor ?? 2
  const jitter = options.jitter ?? 0.25
  const random = options.random ?? Math.random

  let attempts = 0
  let last: number | null = null

  return {
    get attempts() {
      return attempts
    },
    next() {
      const base = Math.min(maxMs, initialMs * factor ** attempts)
      attempts += 1
      const spread = base * jitter
      const delay = Math.round(base - spread / 2 + random() * spread)
      last = Math.max(0, delay)
      return last
    },
    current() {
      return last
    },
    reset() {
      attempts = 0
      last = null
    },
  }
}
