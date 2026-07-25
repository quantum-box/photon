import { describe, expect, it } from 'vitest'

import { newId, uuidV7 } from './id.js'

describe('uuidV7', () => {
  it('produces a well-formed v7 uuid', () => {
    const id = uuidV7(1_700_000_000_000)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('sorts lexicographically by creation time', () => {
    const early = uuidV7(1_700_000_000_000)
    const late = uuidV7(1_700_000_001_000)
    expect(early < late).toBe(true)
  })

  it('does not collide across concurrent creation at the same millisecond', () => {
    // This is the property that lets two offline clients create records without
    // coordinating. The previous max(existing)+1 scheme guaranteed collisions.
    const ids = new Set(Array.from({ length: 2_000 }, () => uuidV7(1_700_000_000_000)))
    expect(ids.size).toBe(2_000)
  })
})

describe('newId', () => {
  it('prefixes when asked, and stays sortable within a prefix', () => {
    const first = newId('rec', 1_700_000_000_000)
    const second = newId('rec', 1_700_000_001_000)
    expect(first.startsWith('rec_')).toBe(true)
    expect(first < second).toBe(true)
  })

  it('returns a bare uuid with no prefix', () => {
    expect(newId(undefined, 1_700_000_000_000)).not.toContain('_')
  })
})
