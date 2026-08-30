import { describe, expect, it, vi } from 'vitest'

import { createRestTransport, decisionForError } from './index.js'
import type { Operation } from '../types.js'

function operation(
  id: string,
  recordId: string,
  kind: Operation['kind'],
  collection = 'issues',
): Operation {
  return {
    id,
    key: { scope: 's', collection, record_id: recordId },
    actor_id: 'a',
    timestamp: { wall_time_ms: 1, counter: 0, actor_id: 'a' },
    kind,
  }
}

function resource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    list: vi.fn(async () => ({ items: [], complete: true })),
    create: vi.fn(async (value: Record<string, unknown>) => ({ id: 'srv-1', ...value })),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toRecord: (item: { id: string }) => ({ recordId: item.id, value: item }),
    ...overrides,
  }
}

describe('decisionForError', () => {
  it('turns client errors into rejections', () => {
    expect(decisionForError('op', { status: 400 })).toMatchObject({ kind: 'rejected' })
    expect(decisionForError('op', { status: 422 })).toMatchObject({ kind: 'rejected' })
  })

  it('turns optimistic-concurrency failures into conflicts', () => {
    for (const status of [409, 412, 428]) {
      expect(decisionForError('op', { status })).toMatchObject({ kind: 'conflict' })
    }
  })

  it('leaves auth and server errors undecided so they stay retryable', () => {
    // Rejecting a 401 would roll back a write the user can make as soon as they
    // sign in again; rejecting a 503 would discard work over a blip.
    expect(decisionForError('op', { status: 401 })).toBeNull()
    expect(decisionForError('op', { status: 403 })).toBeNull()
    expect(decisionForError('op', { status: 500 })).toBeNull()
    expect(decisionForError('op', { status: 503 })).toBeNull()
    expect(decisionForError('op', new TypeError('network down'))).toBeNull()
  })

  it('reads a status nested under response, as axios reports it', () => {
    expect(decisionForError('op', { response: { status: 409 } })).toMatchObject({ kind: 'conflict' })
  })
})

describe('createRestTransport push', () => {
  it('creates, updates and deletes through the app resource', async () => {
    const issues = resource()
    const transport = createRestTransport({ resources: { issues: issues as never } })

    await transport.push({
      scope: 's',
      operations: [operation('o1', 'r1', { type: 'upsert', value: { title: 'a' } })],
    })
    expect(issues.create).toHaveBeenCalledWith({ title: 'a' })

    const withCurrent = createRestTransport({
      resources: { issues: issues as never },
      readRecord: () => ({ title: 'a' }),
    })
    await withCurrent.push({
      scope: 's',
      operations: [operation('o2', 'r1', { type: 'patch', fields: { title: 'b' } })],
    })
    expect(issues.update).toHaveBeenCalledWith('r1', { title: 'b' })

    await transport.push({ scope: 's', operations: [operation('o3', 'r1', { type: 'delete' })] })
    expect(issues.remove).toHaveBeenCalledWith('r1')
  })

  it('reports an alias when the server assigns a different id', async () => {
    const issues = resource({
      create: vi.fn(async () => ({ id: 'server-generated' })),
    })
    const transport = createRestTransport({ resources: { issues: issues as never } })

    const result = await transport.push({
      scope: 's',
      operations: [operation('o1', 'local-temp', { type: 'upsert', value: { title: 'a' } })],
    })

    expect(result.decisions[0]).toMatchObject({
      kind: 'accepted',
      aliasRecordId: 'server-generated',
    })
  })

  it('sends a first write through the resource own upsert', async () => {
    // The bug this guards: the client writes the optimistic value into the
    // projection before the push runs, so `readRecord` reports the record as
    // existing and the create goes out as an update. Against a real backend
    // that is a 404, which is a rejection, so the record the user just made is
    // silently dropped.
    const calls: string[] = []
    const issues = resource({
      create: vi.fn(async () => {
        calls.push('create')
      }),
      upsert: vi.fn(async () => {
        calls.push('upsert')
      }),
      update: vi.fn(async () => {
        calls.push('update')
        throw Object.assign(new Error('not found'), { status: 404 })
      }),
    })
    const transport = createRestTransport({
      resources: { issues: issues as never },
      readRecord: () => ({ title: 'new' }),
    })

    const result = await transport.push({
      scope: 's',
      operations: [operation('o1', 'r1', { type: 'upsert', value: { title: 'new' } })],
    })

    expect(calls).toEqual(['upsert'])
    expect(issues.upsert).toHaveBeenCalledWith('r1', { title: 'new' })
    expect(result.decisions[0]).toMatchObject({ kind: 'accepted' })
  })

  it('reports an alias when upsert returns a server-assigned id', async () => {
    const issues = resource({
      upsert: vi.fn(async () => ({ id: 'server-generated' })),
    })
    const transport = createRestTransport({ resources: { issues: issues as never } })

    const result = await transport.push({
      scope: 's',
      operations: [operation('o1', 'local-temp', { type: 'upsert', value: { title: 'a' } })],
    })

    expect(result.decisions[0]).toMatchObject({
      kind: 'accepted',
      aliasRecordId: 'server-generated',
    })
  })

  it('keeps guessing create-or-update for a resource with no upsert', async () => {
    // Unchanged on purpose. A resource that opts out is telling the adapter its
    // backend has no PUT-style endpoint, so the guess is all there is — and a
    // first write is only safe if that backend tolerates an update to an id it
    // has never seen.
    const fresh = resource()
    const withoutProjection = createRestTransport({ resources: { issues: fresh as never } })
    await withoutProjection.push({
      scope: 's',
      operations: [operation('o1', 'r1', { type: 'upsert', value: { title: 'a' } })],
    })
    expect(fresh.create).toHaveBeenCalledWith({ title: 'a' })
    expect(fresh.update).not.toHaveBeenCalled()

    const seen = resource()
    const withProjection = createRestTransport({
      resources: { issues: seen as never },
      readRecord: () => ({ title: 'a' }),
    })
    await withProjection.push({
      scope: 's',
      operations: [operation('o2', 'r1', { type: 'upsert', value: { title: 'b' } })],
    })
    expect(seen.update).toHaveBeenCalledWith('r1', { title: 'b' })
    expect(seen.create).not.toHaveBeenCalled()
  })

  it('resolves CRDT-only operations against the local value', async () => {
    // REST cannot express "add 1 to whatever the server has", so the adapter
    // computes the result locally and sends a plain patch. Merge semantics are
    // lost here by necessity, not by accident.
    const issues = resource()
    const transport = createRestTransport({
      resources: { issues: issues as never },
      readRecord: () => ({ votes: 4, labels: ['bug'] }),
    })

    await transport.push({
      scope: 's',
      operations: [operation('o1', 'r1', { type: 'increment', field: 'votes', by: 3 })],
    })
    expect(issues.update).toHaveBeenCalledWith('r1', { votes: 7 })

    await transport.push({
      scope: 's',
      operations: [operation('o2', 'r1', { type: 'set_add', field: 'labels', values: ['ui'] })],
    })
    expect(issues.update).toHaveBeenCalledWith('r1', { labels: ['bug', 'ui'] })

    await transport.push({
      scope: 's',
      operations: [operation('o3', 'r1', { type: 'set_remove', field: 'labels', values: ['bug'] })],
    })
    expect(issues.update).toHaveBeenCalledWith('r1', { labels: [] })

    await transport.push({
      scope: 's',
      operations: [operation('o4', 'r1', { type: 'remove_fields', fields: ['votes'] })],
    })
    expect(issues.update).toHaveBeenCalledWith('r1', { votes: null })
  })

  it('sends operations on one record in order and stops after a failure', async () => {
    const calls: string[] = []
    const issues = resource({
      create: vi.fn(async () => {
        calls.push('create')
        throw Object.assign(new Error('bad request'), { status: 422 })
      }),
      update: vi.fn(async () => {
        calls.push('update')
      }),
    })
    const transport = createRestTransport({ resources: { issues: issues as never } })

    const result = await transport.push({
      scope: 's',
      operations: [
        operation('o1', 'r1', { type: 'upsert', value: { title: 'a' } }),
        operation('o2', 'r1', { type: 'patch', fields: { title: 'b' } }),
      ],
    })

    // The patch is never attempted: it assumed a record the create failed to
    // make.
    expect(calls).toEqual(['create'])
    expect(result.decisions).toHaveLength(2)
    expect(result.decisions[0]).toMatchObject({ kind: 'rejected' })
    expect(result.decisions[1]).toMatchObject({ kind: 'rejected' })
  })

  it('rethrows transport failures so the sync loop retries them', async () => {
    const issues = resource({
      create: vi.fn(async () => {
        throw Object.assign(new Error('gateway'), { status: 502 })
      }),
    })
    const transport = createRestTransport({ resources: { issues: issues as never } })

    await expect(
      transport.push({
        scope: 's',
        operations: [operation('o1', 'r1', { type: 'upsert', value: {} })],
      }),
    ).rejects.toThrow('gateway')
  })

  it('rejects operations for a collection with no configured resource', async () => {
    const transport = createRestTransport({ resources: {} })
    const result = await transport.push({
      scope: 's',
      operations: [operation('o1', 'r1', { type: 'upsert', value: {} }, 'unknown')],
    })
    expect(result.decisions[0]).toMatchObject({ kind: 'rejected' })
  })
})

describe('createRestTransport pull', () => {
  it('returns a snapshot and preserves the completeness claim', async () => {
    const issues = resource({
      list: vi.fn(async () => ({ items: [{ id: 'r1' }, { id: 'r2' }], complete: true })),
    })
    const transport = createRestTransport({ resources: { issues: issues as never } })

    const page = await transport.pull({ scope: 's', cursor: null, limit: 100 })
    expect(page).toMatchObject({ kind: 'snapshot', collection: 'issues', complete: true })
    if (page.kind === 'snapshot') expect(page.records).toHaveLength(2)
  })

  it('defaults completeness to false for a bare array', async () => {
    // Claiming completeness for a paginated response deletes local records that
    // still exist, so the unsafe side has to be the one you opt into.
    const issues = resource({ list: vi.fn(async () => [{ id: 'r1' }]) })
    const transport = createRestTransport({ resources: { issues: issues as never } })

    const page = await transport.pull({ scope: 's', cursor: null, limit: 100 })
    expect(page).toMatchObject({ complete: false })
  })

  it('round-robins collections so one cannot starve the others', async () => {
    const issues = resource()
    const docs = resource()
    const transport = createRestTransport({
      resources: { issues: issues as never, docs: docs as never },
    })

    const first = await transport.pull({ scope: 's', cursor: null, limit: 100 })
    const second = await transport.pull({ scope: 's', cursor: null, limit: 100 })
    expect([first, second].map((p) => (p.kind === 'snapshot' ? p.collection : null)).sort()).toEqual(
      ['docs', 'issues'],
    )
  })
})
