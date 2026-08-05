import { describe, expect, it, vi } from 'vitest'

import type { Operation } from '../types.js'
import { createEngineTransport } from './engine-transport.js'

const operation: Operation = {
  id: 'op-1',
  key: { scope: 'tenant:test:workspace:main', collection: 'records', record_id: 'r1' },
  actor_id: 'actor-1',
  timestamp: { wall_time_ms: 1, counter: 0, actor_id: 'actor-1' },
  kind: { type: 'upsert', value: { title: 'test' } },
}

function transportWith(body: unknown) {
  return createEngineTransport({
    baseUrl: 'https://engine.invalid',
    fetch: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  })
}

describe('createEngineTransport push decisions', () => {
  it('parses the Rust tagged decision shape', async () => {
    const result = await transportWith({
      decisions: [{ type: 'accepted', operation_id: operation.id, remote_sequence: 7 }],
    }).push({ scope: operation.key.scope, operations: [operation] })

    expect(result.decisions).toEqual([
      { kind: 'accepted', operationId: operation.id, remoteSequence: 7 },
    ])
  })

  it('parses a nested Rust conflict without dropping its reason', async () => {
    const result = await transportWith({
      decisions: [
        {
          type: 'conflict',
          operation_id: operation.id,
          conflict: { reason: 'status transition denied', remote_value: { status: 'closed' } },
        },
      ],
    }).push({ scope: operation.key.scope, operations: [operation] })

    expect(result.decisions).toEqual([
      {
        kind: 'conflict',
        operationId: operation.id,
        reason: 'status transition denied',
        remoteValue: { status: 'closed' },
      },
    ])
  })

  it.each([
    [{}, 'decisions array'],
    [{ decisions: [{ operation_id: operation.id }] }, 'single decision kind'],
    [
      { decisions: [{ type: 1, kind: 'accepted', operation_id: operation.id }] },
      'invalid decision kind',
    ],
    [
      { decisions: [{ type: 'future_kind', operation_id: operation.id }] },
      'unsupported kind',
    ],
    [
      { decisions: [{ type: 'rejected', operation_id: operation.id }] },
      'reason must be a non-empty string',
    ],
    [
      { decisions: [{ type: 'accepted', operation_id: operation.id }] },
      'remote_sequence must be a non-negative safe integer',
    ],
    [
      {
        decisions: [
          {
            type: 'accepted',
            decision: 'rejected',
            operation_id: operation.id,
            reason: 'ambiguous',
          },
        ],
      },
      'single decision kind',
    ],
  ])('fails closed for malformed payload %#', async (body, message) => {
    await expect(
      transportWith(body).push({ scope: operation.key.scope, operations: [operation] }),
    ).rejects.toThrow(message)
  })
})
