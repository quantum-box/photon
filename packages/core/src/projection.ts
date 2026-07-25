/**
 * The in-memory projection.
 *
 * This is the read path. Storage is the durable log behind it, not the source
 * reads go through — that inversion is what lets `getSnapshot()` be synchronous.
 *
 * The single rule this module exists to enforce: a `PhotonRecord` object is
 * replaced only when its content changes. Everything above depends on it —
 * query result diffing, React memoization, and the "one field edit must not
 * re-render 10,000 rows" property.
 */

import { recordKeyIndex } from './scope.js'
import type {
  Collection,
  EngineRecord,
  PhotonRecord,
  RecordChange,
  RecordId,
  Scope,
} from './types.js'

export class Projection {
  private readonly records = new Map<string, PhotonRecord>()
  private readonly byCollection = new Map<Collection, Set<string>>()
  /** Record index → count of unacknowledged operations touching it. */
  private readonly pendingCounts = new Map<string, number>()

  constructor(private readonly scope: Scope) {}

  index(collection: Collection, recordId: RecordId): string {
    return recordKeyIndex(this.scope, collection, recordId)
  }

  get(collection: Collection, recordId: RecordId): PhotonRecord | null {
    return this.records.get(this.index(collection, recordId)) ?? null
  }

  *recordsIn(collection: Collection): Iterable<PhotonRecord> {
    const indices = this.byCollection.get(collection)
    if (!indices) return
    for (const index of indices) {
      const record = this.records.get(index)
      if (record) yield record
    }
  }

  collections(): Iterable<Collection> {
    return this.byCollection.keys()
  }

  countIn(collection: Collection): number {
    return this.byCollection.get(collection)?.size ?? 0
  }

  get pendingRecordCount(): number {
    return this.pendingCounts.size
  }

  /**
   * Write an engine record into the projection.
   *
   * Returns the change if anything is actually different, or null — callers use
   * that to decide whether to notify, so an idempotent write stays silent.
   */
  set(engine: EngineRecord, options: { durable: boolean; aliasOf?: RecordId }): RecordChange | null {
    const collection = engine.key.collection
    const index = this.index(collection, engine.key.record_id)
    const previous = this.records.get(index) ?? null

    const next: PhotonRecord = {
      key: engine.key,
      value: engine.value,
      version: engine.version,
      fieldVersions: engine.field_versions,
      deletedAt: engine.deleted_at,
      updatedBy: engine.updated_by,
      pending: (this.pendingCounts.get(index) ?? 0) > 0,
      durable: options.durable,
      ...(options.aliasOf ? { aliasOf: options.aliasOf } : {}),
    }

    if (previous && recordsEqual(previous, next)) return null

    this.records.set(index, next)
    let bucket = this.byCollection.get(collection)
    if (!bucket) {
      bucket = new Set()
      this.byCollection.set(collection, bucket)
    }
    bucket.add(index)

    return { collection, recordId: engine.key.record_id, previous, next }
  }

  /** Drop a record entirely. Used for tombstone reconciliation and alias swaps. */
  remove(collection: Collection, recordId: RecordId): RecordChange | null {
    const index = this.index(collection, recordId)
    const previous = this.records.get(index)
    if (!previous) return null

    this.records.delete(index)
    this.pendingCounts.delete(index)
    this.byCollection.get(collection)?.delete(index)

    return { collection, recordId, previous, next: null }
  }

  /** Mark that an unacknowledged operation now targets this record. */
  addPending(collection: Collection, recordId: RecordId): RecordChange | null {
    const index = this.index(collection, recordId)
    this.pendingCounts.set(index, (this.pendingCounts.get(index) ?? 0) + 1)
    return this.refreshFlags(collection, recordId)
  }

  /** Drop one unacknowledged operation from this record. */
  releasePending(collection: Collection, recordId: RecordId): RecordChange | null {
    const index = this.index(collection, recordId)
    const count = this.pendingCounts.get(index) ?? 0
    if (count <= 1) this.pendingCounts.delete(index)
    else this.pendingCounts.set(index, count - 1)
    return this.refreshFlags(collection, recordId)
  }

  markDurable(collection: Collection, recordId: RecordId): RecordChange | null {
    const index = this.index(collection, recordId)
    const previous = this.records.get(index)
    if (!previous || previous.durable) return null
    const next = { ...previous, durable: true }
    this.records.set(index, next)
    return { collection, recordId, previous, next }
  }

  private refreshFlags(collection: Collection, recordId: RecordId): RecordChange | null {
    const index = this.index(collection, recordId)
    const previous = this.records.get(index)
    if (!previous) return null
    const pending = (this.pendingCounts.get(index) ?? 0) > 0
    if (previous.pending === pending) return null
    const next = { ...previous, pending }
    this.records.set(index, next)
    return { collection, recordId, previous, next }
  }
}

function recordsEqual(a: PhotonRecord, b: PhotonRecord): boolean {
  return (
    a.value === b.value &&
    a.version.wall_time_ms === b.version.wall_time_ms &&
    a.version.counter === b.version.counter &&
    a.version.actor_id === b.version.actor_id &&
    a.deletedAt?.wall_time_ms === b.deletedAt?.wall_time_ms &&
    a.deletedAt?.counter === b.deletedAt?.counter &&
    a.pending === b.pending &&
    a.durable === b.durable &&
    a.aliasOf === b.aliasOf
  )
}
