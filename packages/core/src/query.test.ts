import { describe, expect, it } from 'vitest'

import { buildComparator, matchesWhere } from './query.js'
import type { PhotonRecord } from './types.js'

function record(id: string, value: unknown): PhotonRecord {
  return {
    key: { scope: 's', collection: 'c', record_id: id },
    value,
    version: { wall_time_ms: 0, counter: 0, actor_id: 'a' },
    fieldVersions: {},
    deletedAt: null,
    updatedBy: 'a',
    pending: false,
    durable: true,
  }
}

describe('matchesWhere', () => {
  it('treats a bare value as equality', () => {
    expect(matchesWhere({ status: 'todo' }, { status: 'todo' })).toBe(true)
    expect(matchesWhere({ status: 'done' }, { status: 'todo' })).toBe(false)
  })

  it('supports comparison operators', () => {
    expect(matchesWhere({ n: 5 }, { n: { gt: 3 } })).toBe(true)
    expect(matchesWhere({ n: 5 }, { n: { lte: 4 } })).toBe(false)
    expect(matchesWhere({ s: 'todo' }, { s: { ne: 'done' } })).toBe(true)
    expect(matchesWhere({ s: 'todo' }, { s: { in: ['todo', 'doing'] } })).toBe(true)
    expect(matchesWhere({ s: 'todo' }, { s: { nin: ['todo'] } })).toBe(false)
  })

  it('distinguishes missing fields from null in exists', () => {
    expect(matchesWhere({ a: 1 }, { b: { exists: false } })).toBe(true)
    expect(matchesWhere({ b: null }, { b: { exists: false } })).toBe(true)
    expect(matchesWhere({ b: 0 }, { b: { exists: true } })).toBe(true)
  })

  it('does not treat a missing field as satisfying an ordering test', () => {
    expect(matchesWhere({}, { n: { gt: 0 } })).toBe(false)
    expect(matchesWhere({}, { n: { lt: 0 } })).toBe(false)
  })

  it('reads dotted paths so nested values need no function predicate', () => {
    expect(matchesWhere({ meta: { owner: 'ada' } }, { 'meta.owner': 'ada' })).toBe(true)
    expect(matchesWhere({ meta: null }, { 'meta.owner': 'ada' })).toBe(false)
  })

  it('matches contains against both strings and arrays', () => {
    expect(matchesWhere({ labels: ['bug', 'ui'] }, { labels: { contains: 'ui' } })).toBe(true)
    expect(matchesWhere({ title: 'fix the bug' }, { title: { contains: 'bug' } })).toBe(true)
  })
})

describe('buildComparator', () => {
  it('falls back to record id, which is creation order for uuid v7', () => {
    const compare = buildComparator(undefined)
    expect(compare(record('a', {}), record('b', {}))).toBeLessThan(0)
  })

  it('orders by field and honours direction', () => {
    const asc = buildComparator([{ field: 'n' }])
    const desc = buildComparator([{ field: 'n', direction: 'desc' }])
    const one = record('1', { n: 1 })
    const two = record('2', { n: 2 })
    expect(asc(one, two)).toBeLessThan(0)
    expect(desc(one, two)).toBeGreaterThan(0)
  })

  it('breaks ties with the next key, then by id', () => {
    const compare = buildComparator([{ field: 'a' }, { field: 'b' }])
    expect(compare(record('x', { a: 1, b: 1 }), record('y', { a: 1, b: 2 }))).toBeLessThan(0)
    expect(compare(record('x', { a: 1, b: 1 }), record('y', { a: 1, b: 1 }))).toBeLessThan(0)
  })
})
