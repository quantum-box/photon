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
  constructor(
    private readonly db: PGlite,
    readonly dataDir: string,
  ) {}

  async migrate(): Promise<void> {
    await this.db.exec(SCHEMA)
  }

  async loadRecords(scope: Scope): Promise<EngineRecord[]> {
    const result = await this.db.query<{ record_json: string }>(
      'SELECT record_json FROM photon_engine_records WHERE scope = $1',
      [scope],
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
    await this.db.close()
  }
}

export async function createPGliteStore(
  options: PGliteStoreOptions = {},
): Promise<LocalStore> {
  const db = options.client ?? (await PGlite.create(options.dataDir))
  return new PGliteStore(db, options.dataDir ?? 'memory://')
}
