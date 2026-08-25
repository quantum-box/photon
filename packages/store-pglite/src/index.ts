/**
 * PGlite-backed durable storage.
 *
 * Storage is a write-ahead log plus a record projection, not the read path —
 * the client reads from memory. So this only has to be correct and atomic, not
 * fast to query.
 *
 * The whole reason `LocalStore` is ~10 methods is so this file can be swapped
 * for OPFS-SQLite, IndexedDB, or a native Tauri store without the engine API
 * changing. Nothing above this import boundary knows PGlite exists.
 */

import { PGlite } from '@electric-sql/pglite'
import type {
  Collection,
  Conflict,
  CursorRow,
  EngineRecord,
  LoadRecordsOptions,
  LocalStore,
  OperationStatus,
  RecordId,
  Scope,
  StoreWrite,
  StoredOperation,
} from '@quantum-box/photon-core'

export interface PGliteStoreOptions {
  /**
   * e.g. `idb://photon-acme-roadmap`, or a filesystem path under Node.
   *
   * Omit it for an in-memory database. That is a real choice with real
   * consequences — nothing survives a reload — so it is never selected
   * implicitly on the caller's behalf.
   */
  readonly dataDir?: string
  /** Reuse an already-open instance instead of creating one. */
  readonly client?: PGlite
  /**
   * Claim a cross-tab exclusive lock (Web Locks API) on `dataDir` before
   * opening. PGlite holds a single connection per data directory; a second
   * *tab* on the same directory is invisible to the in-process registry and
   * corrupts silently. With this on, the second tab fails loudly with
   * `PGliteStoreLockedError` instead.
   *
   * Opt-in because it changes multi-tab behavior: without a takeover story
   * (leader election, SharedWorker), the honest options are "second tab may
   * corrupt" and "second tab refuses to open" — the host picks. Where the
   * Web Locks API does not exist (Node, very old WebViews) the guard degrades
   * to the in-process registry with a console warning.
   */
  readonly exclusiveLock?: boolean
}

/** Another tab (or window) already holds this data directory. */
export class PGliteStoreLockedError extends Error {
  constructor(readonly lockName: string) {
    super(
      `Another tab already holds the PGlite database ${lockName}. ` +
        'Close it (or its Photon client) before opening a new one.',
    )
    this.name = 'PGliteStoreLockedError'
  }
}

/** The slice of the Web Locks API this module uses; avoids requiring DOM lib types. */
interface WebLockManager {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: object | null) => Promise<unknown>,
  ): Promise<unknown>
}

interface WebLocksHost {
  navigator?: { locks?: WebLockManager }
}

/**
 * Hold a Web Lock for the store's lifetime. Resolves to a release function,
 * or rejects with [`PGliteStoreLockedError`] when another tab holds it.
 */
async function acquireExclusiveLock(lockName: string): Promise<() => void> {
  const locks = (globalThis as WebLocksHost).navigator?.locks
  if (!locks) {
    console.warn(
      `Photon: exclusiveLock was requested for ${lockName}, but the Web Locks API ` +
        'is unavailable here. Falling back to the in-process guard only.',
    )
    return () => {}
  }

  return await new Promise<() => void>((resolveAcquired, rejectAcquired) => {
    let release!: () => void
    const held = new Promise<void>((resolveRelease) => {
      release = resolveRelease
    })
    // `ifAvailable` instead of queueing: a second tab waiting forever on a
    // lock looks exactly like a hang. Failing immediately is diagnosable.
    void locks
      .request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          rejectAcquired(new PGliteStoreLockedError(lockName))
          return
        }
        resolveAcquired(release)
        await held
      })
      .catch(rejectAcquired)
  })
}

/**
 * The write-ahead commit journal.
 *
 * PGlite's `idb://` filesystem is best-effort about when bytes actually reach
 * IndexedDB: its per-query flush is coalesced and diffed by file mtime, and in
 * practice a committed transaction can sit only in WASM memory long after the
 * query resolved — sometimes for the whole session. A reload in that state
 * silently loses committed writes, which is exactly the offline mutation this
 * store exists to preserve.
 *
 * So durability does not ride on PGlite's flush at all. Every `commit()` first
 * appends its `StoreWrite` to this journal — a plain IndexedDB store written
 * with `durability: 'strict'`, whose transaction completion is a real
 * durability point — and then applies it to PGlite. The same PGlite
 * transaction records the journal sequence it covers in a checkpoint row. On
 * boot, entries newer than the checkpoint that survived in PGlite's durable
 * image are replayed; entries at or below it are pruned. Replay is idempotent:
 * operations insert with ON CONFLICT DO NOTHING, records and cursors upsert,
 * and entries apply oldest-first so the newest write wins.
 */
class CommitJournal {
  private constructor(private readonly db: IDBDatabase) {}

  static readonly STORE = 'commits'

  static async open(dataDir: string): Promise<CommitJournal> {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!idb) throw new Error('IndexedDB is unavailable')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(`photon-commit-journal:${dataDir}`, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CommitJournal.STORE)) {
          request.result.createObjectStore(CommitJournal.STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('failed to open the commit journal'))
    })
    return new CommitJournal(db)
  }

  /** Resolves when the entry is durably committed, not merely queued. */
  append(seq: number, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(CommitJournal.STORE, 'readwrite', { durability: 'strict' })
      tx.objectStore(CommitJournal.STORE).put(payload, seq)
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('commit journal write failed'))
    })
  }

  entriesAfter(seq: number): Promise<{ seq: number; payload: string }[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(CommitJournal.STORE, 'readonly')
      const entries: { seq: number; payload: string }[] = []
      const cursor = tx
        .objectStore(CommitJournal.STORE)
        .openCursor(IDBKeyRange.lowerBound(seq, true))
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) {
          resolve(entries)
          return
        }
        entries.push({ seq: Number(row.key), payload: row.value as string })
        row.continue()
      }
      cursor.onerror = () => reject(cursor.error ?? new Error('commit journal read failed'))
    })
  }

  deleteUpTo(seq: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(CommitJournal.STORE, 'readwrite')
      tx.objectStore(CommitJournal.STORE).delete(IDBKeyRange.upperBound(seq))
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('commit journal prune failed'))
    })
  }

  close(): void {
    this.db.close()
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photon_engine_operations (
  operation_id     TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  collection       TEXT NOT NULL,
  record_id        TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  operation_json   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  local_sequence   BIGSERIAL,
  remote_sequence  BIGINT,
  received_at_ms   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photon_ops_scope_status
  ON photon_engine_operations(scope, status, local_sequence);
CREATE INDEX IF NOT EXISTS idx_photon_ops_record
  ON photon_engine_operations(scope, collection, record_id, local_sequence);

CREATE TABLE IF NOT EXISTS photon_engine_records (
  scope         TEXT NOT NULL,
  collection    TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  record_json   TEXT NOT NULL,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (scope, collection, record_id)
);

CREATE TABLE IF NOT EXISTS photon_engine_cursors (
  scope          TEXT NOT NULL,
  remote         TEXT NOT NULL,
  position       BIGINT NOT NULL,
  updated_at_ms  BIGINT NOT NULL,
  PRIMARY KEY (scope, remote)
);

CREATE TABLE IF NOT EXISTS photon_engine_conflicts (
  conflict_id    TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  collection     TEXT NOT NULL,
  record_id      TEXT NOT NULL,
  operation_id   TEXT NOT NULL,
  reason         TEXT NOT NULL,
  local_json     TEXT,
  remote_json    TEXT,
  created_at_ms  BIGINT NOT NULL,
  resolved       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_photon_conflicts_scope
  ON photon_engine_conflicts(scope, resolved);

CREATE TABLE IF NOT EXISTS photon_engine_journal_checkpoint (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  seq  BIGINT NOT NULL
);
`

interface OperationRow {
  operation_json: string
  status: string
  local_sequence: string | number
  remote_sequence: string | number | null
  received_at_ms: string | number
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

function toStored(row: OperationRow): StoredOperation {
  return {
    operation: JSON.parse(row.operation_json),
    status: row.status as OperationStatus,
    localSequence: toNumber(row.local_sequence),
    remoteSequence: row.remote_sequence === null ? null : toNumber(row.remote_sequence),
    receivedAtMs: toNumber(row.received_at_ms),
  }
}

class PGliteStore implements LocalStore {
  /** Non-null only for `idb://` data directories — see [`CommitJournal`]. */
  private journal: CommitJournal | null = null
  private journalSeq = 0

  constructor(
    private readonly db: PGlite,
    readonly dataDir: string,
    private readonly releaseLock: () => void = () => {},
  ) {}

  async migrate(): Promise<void> {
    await this.db.exec(SCHEMA)
    if (!this.dataDir.startsWith('idb://') || this.journal) return

    try {
      this.journal = await CommitJournal.open(this.dataDir)
    } catch (error) {
      // No journal means falling back to PGlite's own (leaky) persistence —
      // degraded durability, not a broken store. Say so once and move on.
      console.warn(
        'Photon: commit journal unavailable, offline writes may not survive a reload',
        error,
      )
      return
    }

    // Everything at or below the checkpoint is already inside the durable
    // PGlite image this boot loaded — the checkpoint row commits in the same
    // PGlite transaction as the data it covers, so they survive or vanish
    // together. Entries above it are the writes PGlite's filesystem lost;
    // replaying them oldest-first puts them back.
    const durableSeq = await this.readCheckpoint()
    await this.journal.deleteUpTo(durableSeq)
    const entries = await this.journal.entriesAfter(durableSeq)
    for (const entry of entries) {
      await this.applyWrite(JSON.parse(entry.payload) as StoreWrite, entry.seq)
    }
    this.journalSeq = entries.length ? entries[entries.length - 1]!.seq : durableSeq
  }

  private async readCheckpoint(): Promise<number> {
    const result = await this.db.query<{ seq: string | number }>(
      'SELECT seq FROM photon_engine_journal_checkpoint WHERE id = 1',
    )
    return toNumber(result.rows[0]?.seq)
  }

  async loadRecords(scope: Scope, options?: LoadRecordsOptions): Promise<EngineRecord[]> {
    const conditions = ['scope = $1']
    const params: unknown[] = [scope]

    if (options?.collection !== undefined) {
      params.push(options.collection)
      conditions.push(`collection = $${params.length}`)
    } else if (options?.excludeCollections?.length) {
      const placeholders = options.excludeCollections.map((collection) => {
        params.push(collection)
        return `$${params.length}`
      })
      conditions.push(`collection NOT IN (${placeholders.join(', ')})`)
    }

    const result = await this.db.query<{ record_json: string }>(
      `SELECT record_json FROM photon_engine_records WHERE ${conditions.join(' AND ')}`,
      params,
    )
    return result.rows.map((row) => JSON.parse(row.record_json) as EngineRecord)
  }

  async loadPendingOperations(scope: Scope): Promise<StoredOperation[]> {
    const result = await this.db.query<OperationRow>(
      `SELECT operation_json, status, local_sequence, remote_sequence, received_at_ms
         FROM photon_engine_operations
        WHERE scope = $1 AND status = 'pending'
        ORDER BY local_sequence ASC`,
      [scope],
    )
    return result.rows.map(toStored)
  }

  async loadAcceptedOperations(
    scope: Scope,
    collection: Collection,
    recordId: RecordId,
  ): Promise<StoredOperation[]> {
    const result = await this.db.query<OperationRow>(
      `SELECT operation_json, status, local_sequence, remote_sequence, received_at_ms
         FROM photon_engine_operations
        WHERE scope = $1 AND collection = $2 AND record_id = $3 AND status = 'accepted'
        ORDER BY local_sequence ASC`,
      [scope, collection, recordId],
    )
    return result.rows.map(toStored)
  }

  async loadOperationIds(scope: Scope): Promise<string[]> {
    const result = await this.db.query<{ operation_id: string }>(
      'SELECT operation_id FROM photon_engine_operations WHERE scope = $1',
      [scope],
    )
    return result.rows.map((row) => row.operation_id)
  }

  async loadConflicts(scope: Scope): Promise<Conflict[]> {
    const result = await this.db.query<{
      conflict_id: string
      collection: string
      record_id: string
      operation_id: string
      reason: string
      local_json: string | null
      remote_json: string | null
      created_at_ms: string | number
    }>(
      `SELECT conflict_id, collection, record_id, operation_id, reason,
              local_json, remote_json, created_at_ms
         FROM photon_engine_conflicts
        WHERE scope = $1 AND resolved = FALSE
        ORDER BY created_at_ms ASC`,
      [scope],
    )
    return result.rows.map((row) => ({
      id: row.conflict_id,
      key: { scope, collection: row.collection, record_id: row.record_id },
      operationId: row.operation_id,
      reason: row.reason,
      localValue: row.local_json ? JSON.parse(row.local_json) : null,
      remoteValue: row.remote_json ? JSON.parse(row.remote_json) : null,
      createdAtMs: toNumber(row.created_at_ms),
    }))
  }

  async getCursor(scope: Scope, remote: string): Promise<CursorRow | null> {
    const result = await this.db.query<{ position: string | number; updated_at_ms: string | number }>(
      'SELECT position, updated_at_ms FROM photon_engine_cursors WHERE scope = $1 AND remote = $2',
      [scope, remote],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      scope,
      remote,
      position: toNumber(row.position),
      updatedAtMs: toNumber(row.updated_at_ms),
    }
  }

  async commit(write: StoreWrite): Promise<void> {
    if (!this.journal) {
      await this.applyWrite(write, null)
      return
    }

    // Journal first: once `append` resolves the write can always be replayed,
    // so a crash or reload at any later point cannot lose it. The reverse
    // order would reopen the exact hole this journal exists to close — a
    // PGlite "commit" whose bytes never reach IndexedDB.
    const seq = ++this.journalSeq
    await this.journal.append(seq, JSON.stringify(write))
    await this.applyWrite(write, seq)
  }

  private async applyWrite(write: StoreWrite, journalSeq: number | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = Date.now()

      for (const operation of write.operations ?? []) {
        // A pull returns operations we may already hold. Upsert rather than
        // insert so the echo is idempotent instead of a UNIQUE violation.
        await tx.query(
          `INSERT INTO photon_engine_operations
             (operation_id, scope, collection, record_id, actor_id, kind,
              operation_json, status, received_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
           ON CONFLICT (operation_id) DO NOTHING`,
          [
            operation.id,
            operation.key.scope,
            operation.key.collection,
            operation.key.record_id,
            operation.actor_id,
            operation.kind.type,
            JSON.stringify(operation),
            now,
          ],
        )
      }

      for (const record of write.records ?? []) {
        await tx.query(
          `INSERT INTO photon_engine_records
             (scope, collection, record_id, record_json, deleted)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (scope, collection, record_id)
           DO UPDATE SET record_json = EXCLUDED.record_json, deleted = EXCLUDED.deleted`,
          [
            record.key.scope,
            record.key.collection,
            record.key.record_id,
            JSON.stringify(record),
            record.deleted_at !== null,
          ],
        )
      }

      for (const target of write.deleteRecords ?? []) {
        await tx.query(
          'DELETE FROM photon_engine_records WHERE scope = $1 AND collection = $2 AND record_id = $3',
          [target.scope, target.collection, target.recordId],
        )
      }

      for (const update of write.statusUpdates ?? []) {
        // Only the status and remote sequence move. Rewriting operation_json
        // here would be pure write amplification and would quietly normalize
        // away any schema drift instead of surfacing it.
        await tx.query(
          `UPDATE photon_engine_operations
              SET status = $2, remote_sequence = COALESCE($3, remote_sequence)
            WHERE operation_id = $1`,
          [update.operationId, update.status, update.remoteSequence ?? null],
        )
      }

      for (const conflict of write.conflicts ?? []) {
        await tx.query(
          `INSERT INTO photon_engine_conflicts
             (conflict_id, scope, collection, record_id, operation_id, reason,
              local_json, remote_json, created_at_ms, resolved)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
           ON CONFLICT (conflict_id) DO NOTHING`,
          [
            conflict.id,
            conflict.key.scope,
            conflict.key.collection,
            conflict.key.record_id,
            conflict.operationId,
            conflict.reason,
            JSON.stringify(conflict.localValue ?? null),
            JSON.stringify(conflict.remoteValue ?? null),
            conflict.createdAtMs,
          ],
        )
      }

      for (const conflictId of write.resolveConflictIds ?? []) {
        await tx.query(
          'UPDATE photon_engine_conflicts SET resolved = TRUE WHERE conflict_id = $1',
          [conflictId],
        )
      }

      // Same transaction as the operations it covers: committing the cursor
      // separately means a crash in between skips a page of remote operations
      // permanently.
      if (write.cursor) {
        await tx.query(
          `INSERT INTO photon_engine_cursors (scope, remote, position, updated_at_ms)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (scope, remote)
           DO UPDATE SET position = EXCLUDED.position, updated_at_ms = EXCLUDED.updated_at_ms`,
          [write.cursor.scope, write.cursor.remote, write.cursor.position, write.cursor.updatedAtMs],
        )
      }

      // In the same transaction as the data, so whatever durable image a
      // future boot recovers, its checkpoint names exactly the journal
      // entries that image contains.
      if (journalSeq !== null) {
        await tx.query(
          `INSERT INTO photon_engine_journal_checkpoint (id, seq)
           VALUES (1, $1)
           ON CONFLICT (id)
           DO UPDATE SET seq = GREATEST(photon_engine_journal_checkpoint.seq, EXCLUDED.seq)`,
          [journalSeq],
        )
      }
    })
  }

  async stats(scope: Scope): Promise<{
    operations: Record<OperationStatus, number>
    recordsByCollection: Record<Collection, number>
  }> {
    const statuses = await this.db.query<{ status: string; count: string | number }>(
      'SELECT status, COUNT(*) AS count FROM photon_engine_operations WHERE scope = $1 GROUP BY status',
      [scope],
    )
    const collections = await this.db.query<{ collection: string; count: string | number }>(
      `SELECT collection, COUNT(*) AS count
         FROM photon_engine_records
        WHERE scope = $1 AND deleted = FALSE
        GROUP BY collection`,
      [scope],
    )

    const operations: Record<OperationStatus, number> = {
      pending: 0,
      accepted: 0,
      rejected: 0,
      conflict: 0,
    }
    for (const row of statuses.rows) {
      operations[row.status as OperationStatus] = toNumber(row.count)
    }

    const recordsByCollection: Record<Collection, number> = {}
    for (const row of collections.rows) {
      recordsByCollection[row.collection] = toNumber(row.count)
    }

    return { operations, recordsByCollection }
  }

  raw(): PGlite & { dataDir: string } {
    return Object.assign(this.db, { dataDir: this.dataDir })
  }

  async close(): Promise<void> {
    try {
      await this.db.close()
    } finally {
      this.journal?.close()
      this.journal = null
      this.releaseLock()
    }
  }
}

export async function createPGliteStore(
  options: PGliteStoreOptions = {},
): Promise<LocalStore> {
  const dataDir = options.dataDir ?? 'memory://'
  // Claim the lock before touching the database: opening PGlite on a held
  // directory is exactly the corruption this option exists to prevent.
  const releaseLock = options.exclusiveLock
    ? await acquireExclusiveLock(`photon-pglite:${dataDir}`)
    : () => {}

  try {
    const db = options.client ?? (await PGlite.create(options.dataDir))
    return new PGliteStore(db, dataDir, releaseLock)
  } catch (error) {
    releaseLock()
    throw error
  }
}
