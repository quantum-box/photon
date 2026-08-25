/**
 * Durable local storage.
 *
 * Deliberately ~10 methods rather than a port of the 17-method Rust
 * `StorageAdapter` trait. This is the seam that lets PGlite be swapped for
 * OPFS-SQLite, IndexedDB, or a native Tauri store if cold-start or footprint
 * measurements demand it — a wide trait would make that swap impractical.
 *
 * Storage is a durable log, not the read path. Reads come from the in-memory
 * projection; this interface only has to make writes survive a reload.
 */

import type {
  Collection,
  Conflict,
  EngineRecord,
  Operation,
  OperationId,
  OperationStatus,
  RecordId,
  Scope,
  StoredOperation,
} from './types.js'

export interface CursorRow {
  readonly scope: Scope
  readonly remote: string
  readonly position: number
  readonly updatedAtMs: number
}

export interface OperationStatusUpdate {
  readonly operationId: OperationId
  readonly status: OperationStatus
  readonly remoteSequence?: number | null
}

/**
 * Narrow a `loadRecords` call to part of the scope.
 *
 * Bootstrap uses `excludeCollections` to skip lazily hydrated collections;
 * `hydrateCollection()` uses `collection` to load exactly one of them later.
 */
export interface LoadRecordsOptions {
  /** Load only this collection. Takes precedence over `excludeCollections`. */
  readonly collection?: Collection
  /** Load everything except these collections. */
  readonly excludeCollections?: readonly Collection[]
}

/** One durable transaction. Everything inside commits or nothing does. */
export interface StoreWrite {
  /** Operations to append. Re-appending a known id is a no-op, not an error. */
  readonly operations?: readonly Operation[]
  readonly records?: readonly EngineRecord[]
  readonly deleteRecords?: readonly { scope: Scope; collection: Collection; recordId: RecordId }[]
  readonly statusUpdates?: readonly OperationStatusUpdate[]
  readonly conflicts?: readonly Conflict[]
  readonly resolveConflictIds?: readonly string[]
  /**
   * Written in the *same* transaction as the operations it covers. Saving it
   * separately means a crash between the two silently skips a page of remote
   * operations forever.
   */
  readonly cursor?: CursorRow
}

export interface LocalStore {
  /** Create tables if absent. Safe to call repeatedly. */
  migrate(): Promise<void>

  /** Every non-deleted record in the scope (or the slice `options` selects), for hydration. */
  loadRecords(scope: Scope, options?: LoadRecordsOptions): Promise<EngineRecord[]>

  /** Operations not yet accepted by the server, oldest first. */
  loadPendingOperations(scope: Scope): Promise<StoredOperation[]>

  /** Accepted operations for one record, oldest first. Used to re-project on rollback. */
  loadAcceptedOperations(
    scope: Scope,
    collection: Collection,
    recordId: RecordId,
  ): Promise<StoredOperation[]>

  /** Operation ids already durably stored, so pull echo can be skipped. */
  loadOperationIds(scope: Scope): Promise<string[]>

  loadConflicts(scope: Scope): Promise<Conflict[]>

  getCursor(scope: Scope, remote: string): Promise<CursorRow | null>

  /** Apply a write atomically. */
  commit(write: StoreWrite): Promise<void>

  /** Counts for the debug surface. */
  stats(scope: Scope): Promise<{
    operations: Record<OperationStatus, number>
    recordsByCollection: Record<Collection, number>
  }>

  /** Escape hatch: the underlying handle, so an app can colocate its own tables. */
  raw(): unknown

  close(): Promise<void>
}
