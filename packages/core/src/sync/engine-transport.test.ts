/**
 * The wire shapes the engine server actually sends.
 *
 * The pull cursor is the load-bearing one: the server mirrors the request and
 * answers with a full SyncCursor *object*. Passing that object through as the
 * engine's numeric cursor made every durable cursor write fail (BIGINT column),
 * which silently rolled back the whole pull commit and re-pulled the entire
 * operation log on every cycle.
 */
import { describe, expect, it } from 'vitest'

import { createEngineTransport } from './engine-transport.js'
import type { Operation } from '../types.js'

function operation(id: string): Operation {
  return {
    id,
    key: { scope: 'workspace:test', collection: 'records', record_id: `r-${id}` },
    actor_id: 'actor-remote',
    timestamp: { wall_time_ms: 1, counter: 0, actor_id: 'actor-remote' },
    kind: { type: 'upsert', value: { n: 1 } },
  } as Operation
}

function fetchReturning(body: unknown): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

describe('engine transport pull', () => {
  it('normalizes an object wire cursor to its numeric position', async () => {
    const transport = createEngineTransport({
      baseUrl: 'http://engine.test',
      fetch: fetchReturning({
        operations: [{ operation: operation('op-1'), remote_sequence: 7 }],
        cursor: { scope: 'workspace:test', remote: 'photon-server', position: 7, updated_at_ms: 0 },
        has_more: false,
      }),
    })

    const page = await transport.pull({ scope: 'workspace:test', cursor: null, limit: 100 })
    if (page.kind !== 'operations') throw new Error('expected an operations page')
    expect(page.cursor).toBe(7)
  })

  it('passes a numeric wire cursor through, including zero', async () => {
    const transport = createEngineTransport({
      baseUrl: 'http://engine.test',
      fetch: fetchReturning({ operations: [], cursor: 0 }),
    })

    const page = await transport.pull({ scope: 'workspace:test', cursor: null, limit: 100 })
    if (page.kind !== 'operations') throw new Error('expected an operations page')
    expect(page.cursor).toBe(0)
  })

  it('falls back to the last remote sequence when the cursor is absent', async () => {
    const transport = createEngineTransport({
      baseUrl: 'http://engine.test',
      fetch: fetchReturning({
        operations: [{ operation: operation('op-2'), remote_sequence: 12 }],
      }),
    })

    const page = await transport.pull({ scope: 'workspace:test', cursor: null, limit: 100 })
    if (page.kind !== 'operations') throw new Error('expected an operations page')
    expect(page.cursor).toBe(12)
  })
})
