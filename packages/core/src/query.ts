/**
 * The reactive read path.
 *
 * Reads are served from an in-memory projection, not from storage. That is what
 * makes `getSnapshot()` synchronous, which is what `useSyncExternalStore`
 * requires and what lets a mutation be visible in the same tick it was issued.
 *
 * Two invariants matter and are both load-bearing:
 *
 * 1. `getSnapshot()` returns a cached value whose identity does not change
 *    until listeners are notified. Violating this is the number-one cause of
 *    infinite render loops in React.
 * 2. Record objects are only reallocated when that record actually changed.
 *    A single-field edit in a 10,000 row collection must not reallocate 10,000
 *    objects, or every memoized row re-renders.
 */

import type { Collection, PhotonRecord, Unsubscribe } from './types.js'

// ---------------------------------------------------------------------------
// Predicate DSL
// ---------------------------------------------------------------------------

export type Comparison =
  | { eq: unknown }
  | { ne: unknown }
  | { gt: number | string }
  | { gte: number | string }
  | { lt: number | string }
  | { lte: number | string }
  | { in: unknown[] }
  | { nin: unknown[] }
  | { contains: string }
  | { exists: boolean }

export type WhereClause = Record<string, unknown | Comparison>

export interface OrderBy {
  readonly field: string
  readonly direction?: 'asc' | 'desc'
}

export interface QueryDescriptor<T = unknown> {
  readonly collection: Collection
  /**
   * Serializable by default. A function predicate changes identity on every
   * render, which makes queries impossible to share or dedupe; use `filter`
   * with explicit `deps` only when the DSL genuinely cannot express the test.
   */
  readonly where?: WhereClause
  readonly filter?: (record: PhotonRecord<T>) => boolean
  readonly deps?: readonly unknown[]
  readonly orderBy?: readonly OrderBy[]
  readonly limit?: number
  readonly offset?: number
  /** Deleted records are excluded unless asked for. */
  readonly includeDeleted?: boolean
}

export type QueryStatus = 'loading' | 'ready' | 'error'

export interface QueryState<R> {
  readonly data: R
  readonly status: QueryStatus
  readonly error: Error | null
  /** At least one record in the result has an unacknowledged write. */
  readonly pending: boolean
}

export interface LiveQuery<R> {
  getSnapshot(): QueryState<R>
  subscribe(listener: () => void): Unsubscribe
  ready(): Promise<void>
  destroy(): void
}

function isComparison(value: unknown): value is Comparison {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1) return false
  return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'exists'].includes(keys[0]!)
}

export function readField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  // Dotted paths so nested values are reachable without a function predicate.
  let current: unknown = value
  for (const segment of field.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function matchesComparison(actual: unknown, comparison: Comparison): boolean {
  if ('eq' in comparison) return actual === comparison.eq
  if ('ne' in comparison) return actual !== comparison.ne
  if ('exists' in comparison) return (actual !== undefined && actual !== null) === comparison.exists
  if ('in' in comparison) return comparison.in.includes(actual)
  if ('nin' in comparison) return !comparison.nin.includes(actual)
  if ('contains' in comparison) {
    if (Array.isArray(actual)) return actual.includes(comparison.contains)
    return typeof actual === 'string' && actual.includes(comparison.contains)
  }
  if (actual === undefined || actual === null) return false
  if ('gt' in comparison) return (actual as number) > (comparison.gt as number)
  if ('gte' in comparison) return (actual as number) >= (comparison.gte as number)
  if ('lt' in comparison) return (actual as number) < (comparison.lt as number)
  if ('lte' in comparison) return (actual as number) <= (comparison.lte as number)
  return false
}

export function matchesWhere(value: unknown, where: WhereClause | undefined): boolean {
  if (!where) return true
  for (const [field, expected] of Object.entries(where)) {
    const actual = readField(value, field)
    if (isComparison(expected)) {
      if (!matchesComparison(actual, expected)) return false
    } else if (actual !== expected) {
      return false
    }
  }
  return true
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}

export function buildComparator<T>(
  orderBy: readonly OrderBy[] | undefined,
): (a: PhotonRecord<T>, b: PhotonRecord<T>) => number {
  if (!orderBy?.length) {
    // Record ids are uuid v7, so id order is creation order.
    return (a, b) => (a.key.record_id < b.key.record_id ? -1 : a.key.record_id > b.key.record_id ? 1 : 0)
  }
  return (a, b) => {
    for (const { field, direction } of orderBy) {
      const result = compareValues(readField(a.value, field), readField(b.value, field))
      if (result !== 0) return direction === 'desc' ? -result : result
    }
    return a.key.record_id < b.key.record_id ? -1 : a.key.record_id > b.key.record_id ? 1 : 0
  }
}

// ---------------------------------------------------------------------------
// Live query implementation
// ---------------------------------------------------------------------------

/** What the query engine needs from the client, kept narrow so it can be tested alone. */
export interface QuerySource<T = unknown> {
  recordsIn(collection: Collection): Iterable<PhotonRecord<T>>
  readonly hydrated: Promise<void>
}

export class CollectionQuery<T> implements LiveQuery<PhotonRecord<T>[]> {
  private listeners = new Set<() => void>()
  private snapshot: QueryState<PhotonRecord<T>[]>
  private destroyed = false
  private readonly comparator: (a: PhotonRecord<T>, b: PhotonRecord<T>) => number

  constructor(
    private readonly descriptor: QueryDescriptor<T>,
    private readonly source: QuerySource<T>,
    private readonly onDestroy: (query: CollectionQuery<T>) => void,
  ) {
    this.comparator = buildComparator<T>(descriptor.orderBy)
    this.snapshot = { data: [], status: 'loading', error: null, pending: false }
  }

  get collection(): Collection {
    return this.descriptor.collection
  }

  getSnapshot(): QueryState<PhotonRecord<T>[]> {
    return this.snapshot
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async ready(): Promise<void> {
    await this.source.hydrated
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.listeners.clear()
    this.onDestroy(this)
  }

  /**
   * Recompute and notify only if the result actually changed.
   *
   * Recomputing the whole collection is O(n) per invalidation. That is the
   * right trade at the sizes this engine targets: it keeps record identity
   * exactly stable, which is worth far more to React than avoiding a scan.
   */
  invalidate(status: QueryStatus = 'ready', error: Error | null = null): boolean {
    if (this.destroyed) return false

    const { where, filter, limit, offset, includeDeleted } = this.descriptor
    const next: PhotonRecord<T>[] = []
    let pending = false

    for (const record of this.source.recordsIn(this.descriptor.collection)) {
      if (!includeDeleted && record.deletedAt) continue
      if (!matchesWhere(record.value, where)) continue
      if (filter && !filter(record)) continue
      next.push(record)
      if (record.pending) pending = true
    }

    next.sort(this.comparator)

    const start = offset ?? 0
    const page = limit === undefined ? next.slice(start) : next.slice(start, start + limit)

    if (
      this.snapshot.status === status &&
      this.snapshot.error === error &&
      this.snapshot.pending === pending &&
      sameRecords(this.snapshot.data, page)
    ) {
      return false
    }

    this.snapshot = { data: page, status, error, pending }
    return true
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/**
 * Identity comparison, not deep equality.
 *
 * The engine guarantees a record object is reallocated only when its content
 * changed, so identity is a sound and cheap change test.
 */
function sameRecords<T>(a: readonly PhotonRecord<T>[], b: readonly PhotonRecord<T>[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Single-record view, backed by the same projection. */
export class RecordQuery<T> implements LiveQuery<PhotonRecord<T> | null> {
  private listeners = new Set<() => void>()
  private snapshot: QueryState<PhotonRecord<T> | null>
  private destroyed = false

  constructor(
    readonly collection: Collection,
    readonly recordId: string,
    private readonly lookup: (collection: Collection, recordId: string) => PhotonRecord<T> | null,
    private readonly hydrated: Promise<void>,
    private readonly onDestroy: (query: RecordQuery<T>) => void,
  ) {
    this.snapshot = { data: null, status: 'loading', error: null, pending: false }
  }

  getSnapshot(): QueryState<PhotonRecord<T> | null> {
    return this.snapshot
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async ready(): Promise<void> {
    await this.hydrated
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.listeners.clear()
    this.onDestroy(this)
  }

  invalidate(status: QueryStatus = 'ready', error: Error | null = null): boolean {
    if (this.destroyed) return false
    const record = this.lookup(this.collection, this.recordId)
    const data = record && record.deletedAt ? null : record
    if (
      this.snapshot.data === data &&
      this.snapshot.status === status &&
      this.snapshot.error === error
    ) {
      return false
    }
    this.snapshot = { data, status, error, pending: data?.pending ?? false }
    return true
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }
}
