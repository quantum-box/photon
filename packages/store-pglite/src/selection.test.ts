import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EngineRecord, LocalStore, SelectionState } from '@quantum-box/photon-core'
import { createPGliteStore } from './index.js'

const scope = 'tenant:scoped:workspace:test'
function record(id: string, value: unknown): EngineRecord {
  return { key: { scope, collection: 'records', record_id: id }, value,
    version: { wall_time_ms: 1, counter: 0, actor_id: 'server' }, field_versions: {}, deleted_at: null, updated_by: 'server' }
}

describe('bounded record reads and selection persistence (real PGlite)', () => {
  let store: LocalStore
  beforeAll(async () => {
    store = await createPGliteStore({})
    await store.migrate()
    await store.commit({ records: [record('a', { region: 'east', n: 1, nil: null }), record('b', { region: 'west', n: 2 }), record('c', { region: 'east', n: 3 })] })
  }, 120_000)
  afterAll(async () => { await store.close() })

  it('filters in storage and keyset-pages without loading a collection', async () => {
    const selection = { collection: 'records', filters: [{ field: 'region', op: 'eq' as const, value: 'east' }], limit: 1 }
    const first = await store.readRecordPage!(scope, selection)
    expect(first.records.map(r => r.key.record_id)).toEqual(['a'])
    expect(first.hasMore).toBe(true)
    const next = await store.readRecordPage!(scope, { ...selection, afterId: first.nextAfterId! })
    expect(next.records.map(r => r.key.record_id)).toEqual(['c'])
    expect(next.hasMore).toBe(false)
    expect((await store.readRecordPage!('another-scope', selection)).records).toEqual([])
  })

  it('distinguishes missing, null and typed scalar comparisons', async () => {
    for (const [field, op, value, ids] of [
      ['nil', 'eq', null, ['a']], ['nil', 'ne', null, ['b', 'c']],
      ['nil', 'exists', true, ['a']], ['n', 'gte', 2, ['b', 'c']],
      ['n', 'gt', '0', []], ['n', 'in', [1, 3], ['a', 'c']],
      ['region', 'in', [], []],
    ] as const) {
      const page = await store.readRecordPage!(scope, { collection: 'records', filters: [{ field, op, value } as never], limit: 10 })
      expect(page.records.map(r => r.key.record_id), `${field} ${op}`).toEqual(ids)
    }
    expect((await store.readRecordPage!(scope, { collection: 'records', recordIds: ['b'], limit: 10 })).records.map(r => r.key.record_id)).toEqual(['b'])
    await expect(store.readRecordPage!(scope, { collection: 'records', filters: [{ field: "x'); DROP TABLE photon_engine_records;--", op: 'eq', value: 1 }], limit: 10 })).rejects.toThrow('field path')
  })

  it('commits membership, checkpoint and cursor in one durable write', async () => {
    const selection: SelectionState = { scope, id: 'east', selector: { collection: 'records' }, cursor: { scope, selector: { collection: 'records' }, phase: 'delta', position: 3, afterId: null }, status: 'complete', updatedAtMs: 100 }
    const base = { record: record('a', { region: 'east', n: 1 }), sequence: 3 }
    await store.commit({ selectionStates: [selection], memberships: [{ scope, subscriptionId: 'east', collection: 'records', recordId: 'a' }], bases: [base], evictions: [{ scope, collection: 'records', recordId: 'a', deferred: true }] })
    expect(await store.getSelectionState!(scope, 'east')).toEqual(selection)
    expect(await store.getRecordMemberships!(scope, 'records', 'a')).toEqual(['east'])
    expect(await store.getRecordBase!(scope, 'records', 'a')).toEqual(base)
    expect(await store.getDeferredEviction!(scope, 'records', 'a')).toBe(true)
    // A malformed record fails AFTER the state/membership statements. They
    // must roll back with it, rather than skipping the page on next startup.
    await expect(store.commit({ selectionStates: [{ ...selection, status: 'partial' }], memberships: [{ scope, subscriptionId: 'east', collection: 'records', recordId: 'a', remove: true }], records: [record(null as never, {})] })).rejects.toBeDefined()
    expect((await store.getSelectionState!(scope, 'east'))?.status).toBe('complete')
    expect(await store.getRecordMemberships!(scope, 'records', 'a')).toEqual(['east'])
  })
})
