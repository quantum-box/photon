import { PGlite } from '@electric-sql/pglite'
import { invoke } from '@tauri-apps/api/core'
import { appKitConfig } from '../../app/kitConfig'

export type PhotonEngineMutationKind = 'upsert' | 'patch' | 'delete'

export interface PhotonEngineRecord<T = unknown> {
  scope: string
  collection: string
  recordId: string
  value: T
  deleted: boolean
  updatedAt: string
}

interface PhotonEngineRecordRow {
  scope: string
  collection: string
  record_id: string
  value_json: string
  record_json?: string | null
  deleted: boolean
  updated_at: string
}

interface PhotonEngineOperationInput {
  collection: string
  recordId: string
  kind: PhotonEngineMutationKind
  value?: unknown
  fields?: object
}

interface PhotonEngineOperationRow {
  operation_id: string
  operation_json: string
  status: string
}

interface PhotonEngineOperationDebugRow extends PhotonEngineOperationRow {
  local_sequence: number
  collection: string
  record_id: string
  created_at: string
}

interface PhotonEngineStatusCountRow {
  status: string
  count: number
}

interface PhotonEngineRecordCountRow {
  count: number
}

export interface ClientEngineDebugState {
  scope: string
  records: number
  operations: {
    pending: number
    accepted: number
    rejected: number
    conflict: number
    total: number
  }
  recentOperations: Array<{
    operationId: string
    collection: string
    recordId: string
    status: string
    localSequence: number
    createdAt: string
    kind: string
  }>
}

const engineScope = `workspace:${appKitConfig.workspace.id}`
const engineActorId = `${appKitConfig.app.id}-client`

const engineDataDir =
  typeof globalThis.indexedDB === 'undefined' ? undefined : appKitConfig.engine.pgliteDataDir

const dbPromise = PGlite.create(engineDataDir).then(async (db) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS photon_engine_records (
      scope TEXT NOT NULL,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      record_json TEXT,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, collection, record_id)
    );

    CREATE INDEX IF NOT EXISTS photon_engine_records_collection_idx
      ON photon_engine_records (scope, collection, deleted, updated_at DESC);

    CREATE TABLE IF NOT EXISTS photon_engine_operations (
      local_sequence SERIAL PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      status TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS photon_engine_operations_pending_idx
      ON photon_engine_operations (scope, status, local_sequence);
  `)
  await db.exec(`
    ALTER TABLE photon_engine_records
      ADD COLUMN IF NOT EXISTS record_json TEXT;
  `)
  return db
})

function randomId(prefix: string) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`
}

function toEngineRecord<T>(row: PhotonEngineRecordRow): PhotonEngineRecord<T> {
  const record = row.record_json ? JSON.parse(row.record_json) as EngineRuntimeRecord : null
  return {
    scope: row.scope,
    collection: row.collection,
    recordId: row.record_id,
    value: (record?.value ?? JSON.parse(row.value_json)) as T,
    deleted: row.deleted,
    updatedAt: row.updated_at,
  }
}

interface EngineRuntimeRecord {
  key: {
    scope: string
    collection: string
    record_id: string
  }
  value: unknown
  version: {
    wall_time_ms: number
    counter: number
    actor_id: string
  }
  field_versions: Record<string, EngineRuntimeRecord['version']>
  deleted_at: EngineRuntimeRecord['version'] | null
  updated_by: string
}

interface WasmPhotonEngineModule {
  default?: () => Promise<unknown>
  photon_engine_apply_operation: (
    current: EngineRuntimeRecord | null,
    operation: EngineRuntimeOperation
  ) => EngineRuntimeRecord
  photon_engine_apply_operation_json?: (
    currentJson: string | undefined,
    operationJson: string
  ) => string
}

interface EngineRuntimeOperation {
  id: string
  key: EngineRuntimeRecord['key']
  actor_id: string
  timestamp: EngineRuntimeRecord['version']
  kind:
    | { type: 'upsert'; value: unknown }
    | { type: 'patch'; fields: object }
    | { type: 'delete' }
  metadata: unknown
}

interface LegacyClientOperation {
  id: string
  key?: {
    scope?: string
    collection?: string
    recordId?: string
    record_id?: string
  }
  actorId?: string
  actor_id?: string
  timestamp?: string | EngineRuntimeRecord['version']
  kind?: PhotonEngineMutationKind | EngineRuntimeOperation['kind']
  value?: unknown
  metadata?: unknown
}

let wasmModulePromise: Promise<WasmPhotonEngineModule> | null = null
let wasmUnavailable = false

function isTauriRuntime() {
  return Boolean((globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

async function loadWasmEngine(): Promise<WasmPhotonEngineModule> {
  if (wasmUnavailable) throw new Error('Photon Engine WASM adapter is unavailable')
  wasmModulePromise ??= import('../../../packages/photon-engine/pkg/photon_engine.js').then(
    async (module: WasmPhotonEngineModule) => {
      await module.default?.()
      return module
    }
  ).catch((error: unknown) => {
    wasmModulePromise = null
    wasmUnavailable = true
    throw error
  })
  return wasmModulePromise
}

function runtimeTimestamp(now = Date.now()): EngineRuntimeRecord['version'] {
  return {
    wall_time_ms: now,
    counter: 0,
    actor_id: engineActorId,
  }
}

function runtimeOperation({
  collection,
  recordId,
  kind,
  value,
  fields,
}: PhotonEngineOperationInput): EngineRuntimeOperation {
  const timestamp = runtimeTimestamp()
  return {
    id: randomId('op'),
    key: {
      scope: engineScope,
      collection,
      record_id: recordId,
    },
    actor_id: engineActorId,
    timestamp,
    kind:
      kind === 'patch'
        ? { type: 'patch', fields: fields ?? {} }
        : kind === 'delete'
          ? { type: 'delete' }
          : { type: 'upsert', value: value ?? {} },
    metadata: { source: 'photon-web-wasm' },
  }
}

function normalizeOperationKind(operation: LegacyClientOperation): EngineRuntimeOperation['kind'] {
  if (typeof operation.kind === 'object' && operation.kind && 'type' in operation.kind) {
    return operation.kind as EngineRuntimeOperation['kind']
  }

  if (operation.kind === 'patch') {
    const fields = operation.value && typeof operation.value === 'object'
      ? operation.value as object
      : {}
    return { type: 'patch', fields }
  }

  if (operation.kind === 'delete') {
    return { type: 'delete' }
  }

  return { type: 'upsert', value: operation.value ?? {} }
}

function normalizeEngineOperation(raw: string): EngineRuntimeOperation {
  const operation = JSON.parse(raw) as LegacyClientOperation
  const key = operation.key ?? {}
  const actorId = operation.actor_id ?? operation.actorId ?? engineActorId
  const timestampMs = typeof operation.timestamp === 'string'
    ? Date.parse(operation.timestamp)
    : Date.now()
  const timestamp = typeof operation.timestamp === 'object' && operation.timestamp
    ? operation.timestamp
    : runtimeTimestamp(Number.isFinite(timestampMs) ? timestampMs : Date.now())

  return {
    id: operation.id,
    key: {
      scope: key.scope ?? engineScope,
      collection: key.collection ?? 'unknown',
      record_id: key.record_id ?? key.recordId ?? 'unknown',
    },
    actor_id: actorId,
    timestamp,
    kind: normalizeOperationKind(operation),
    metadata: operation.metadata ?? { source: 'photon-client-pglite-normalized' },
  }
}

function operationKindLabel(kind: EngineRuntimeOperation['kind']): string {
  return kind.type ?? Object.keys(kind)[0] ?? 'operation'
}

async function getRawEngineRecord(
  collection: string,
  recordId: string
): Promise<EngineRuntimeRecord | null> {
  const db = await dbPromise
  const result = await db.query<PhotonEngineRecordRow>(
    `
      SELECT scope, collection, record_id, value_json, record_json, deleted, updated_at
      FROM photon_engine_records
      WHERE scope = $1 AND collection = $2 AND record_id = $3
      LIMIT 1
    `,
    [engineScope, collection, recordId]
  )
  const row = result.rows[0]
  return row?.record_json ? JSON.parse(row.record_json) as EngineRuntimeRecord : null
}

async function applyWebWasmOperation<T>(
  input: PhotonEngineOperationInput
): Promise<PhotonEngineRecord<T> | null> {
  const db = await dbPromise
  const operation = runtimeOperation(input)
  const current = await getRawEngineRecord(input.collection, input.recordId)
  const wasm = await loadWasmEngine()
  const projected = wasm.photon_engine_apply_operation_json
    ? JSON.parse(wasm.photon_engine_apply_operation_json(
        current ? JSON.stringify(current) : undefined,
        JSON.stringify(operation)
      )) as EngineRuntimeRecord
    : wasm.photon_engine_apply_operation(current, operation)
  const deleted = projected.deleted_at != null
  const updatedAt = String(projected.version.wall_time_ms)

  await db.query(
    `
      INSERT INTO photon_engine_operations (
        operation_id, scope, collection, record_id, actor_id, status, operation_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
    `,
    [
      operation.id,
      engineScope,
      input.collection,
      input.recordId,
      engineActorId,
      JSON.stringify(operation),
      new Date(operation.timestamp.wall_time_ms).toISOString(),
    ]
  )

  await db.query(
    `
      INSERT INTO photon_engine_records (
        scope, collection, record_id, value_json, record_json, deleted, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (scope, collection, record_id) DO UPDATE SET
        value_json = EXCLUDED.value_json,
        record_json = EXCLUDED.record_json,
        deleted = EXCLUDED.deleted,
        updated_at = EXCLUDED.updated_at
    `,
    [
      engineScope,
      input.collection,
      input.recordId,
      JSON.stringify(projected.value),
      JSON.stringify(projected),
      deleted,
      updatedAt,
    ]
  )

  return deleted ? null : getClientEngineRecord<T>(input.collection, input.recordId)
}

async function applyTauriOperation<T>(
  input: PhotonEngineOperationInput
): Promise<PhotonEngineRecord<T> | null> {
  const db = await dbPromise
  const operation = runtimeOperation(input)
  const current = await getRawEngineRecord(input.collection, input.recordId)
  const projected = await invoke<EngineRuntimeRecord>('photon_engine_apply_operation', {
    current,
    operation,
  })
  const deleted = projected.deleted_at != null
  const updatedAt = String(projected.version.wall_time_ms)

  await db.query(
    `
      INSERT INTO photon_engine_operations (
        operation_id, scope, collection, record_id, actor_id, status, operation_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
    `,
    [
      operation.id,
      engineScope,
      input.collection,
      input.recordId,
      engineActorId,
      JSON.stringify(operation),
      new Date(operation.timestamp.wall_time_ms).toISOString(),
    ]
  )

  await db.query(
    `
      INSERT INTO photon_engine_records (
        scope, collection, record_id, value_json, record_json, deleted, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (scope, collection, record_id) DO UPDATE SET
        value_json = EXCLUDED.value_json,
        record_json = EXCLUDED.record_json,
        deleted = EXCLUDED.deleted,
        updated_at = EXCLUDED.updated_at
    `,
    [
      engineScope,
      input.collection,
      input.recordId,
      JSON.stringify(projected.value),
      JSON.stringify(projected),
      deleted,
      updatedAt,
    ]
  )

  return deleted ? null : getClientEngineRecord<T>(input.collection, input.recordId)
}

async function applyClientOperation<T>({
  collection,
  recordId,
  kind,
  value,
  fields,
}: PhotonEngineOperationInput): Promise<PhotonEngineRecord<T> | null> {
  if (isTauriRuntime()) {
    return applyTauriOperation<T>({ collection, recordId, kind, value, fields })
  }

  if (import.meta.env.MODE === 'test') {
    return applyClientOperationInPgliteForTests<T>({ collection, recordId, kind, value, fields })
  }

  if (!wasmUnavailable) {
    try {
      return await applyWebWasmOperation<T>({ collection, recordId, kind, value, fields })
    } catch (error: unknown) {
      console.warn('Photon Engine WASM adapter unavailable; using PGlite projection fallback', error)
    }
  }

  return applyClientOperationInPgliteForTests<T>({ collection, recordId, kind, value, fields })
}

async function applyClientOperationInPgliteForTests<T>({
  collection,
  recordId,
  kind,
  value,
  fields,
}: PhotonEngineOperationInput): Promise<PhotonEngineRecord<T> | null> {
  const db = await dbPromise
  const now = new Date().toISOString()
  const existing = await getClientEngineRecord<Record<string, unknown>>(collection, recordId, {
    includeDeleted: true,
  })
  const nextValue =
    kind === 'patch'
      ? { ...(existing?.value ?? {}), ...(fields ?? {}) }
      : kind === 'delete'
        ? existing?.value ?? {}
        : value ?? {}
  const deleted = kind === 'delete'
  const operation = runtimeOperation({
    collection,
    recordId,
    kind,
    value: kind === 'patch' ? fields ?? {} : nextValue,
    fields,
  })

  await db.query(
    `
      INSERT INTO photon_engine_operations (
        operation_id, scope, collection, record_id, actor_id, status, operation_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
    `,
    [
      operation.id,
      engineScope,
      collection,
      recordId,
      engineActorId,
      JSON.stringify(operation),
      now,
    ]
  )

  await db.query(
    `
      INSERT INTO photon_engine_records (
        scope, collection, record_id, value_json, deleted, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (scope, collection, record_id) DO UPDATE SET
        value_json = EXCLUDED.value_json,
        deleted = EXCLUDED.deleted,
        updated_at = EXCLUDED.updated_at
    `,
    [engineScope, collection, recordId, JSON.stringify(nextValue), deleted, now]
  )

  return deleted ? null : getClientEngineRecord<T>(collection, recordId)
}

export async function listClientEngineRecords<T>(
  collection: string
): Promise<Array<PhotonEngineRecord<T>>> {
  const db = await dbPromise
  const result = await db.query<PhotonEngineRecordRow>(
    `
      SELECT scope, collection, record_id, value_json, record_json, deleted, updated_at
      FROM photon_engine_records
      WHERE scope = $1 AND collection = $2 AND deleted = FALSE
      ORDER BY updated_at DESC, record_id ASC
    `,
    [engineScope, collection]
  )
  return result.rows.map(toEngineRecord<T>)
}

export async function getClientEngineRecord<T>(
  collection: string,
  recordId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<PhotonEngineRecord<T> | null> {
  const db = await dbPromise
  const result = await db.query<PhotonEngineRecordRow>(
    `
      SELECT scope, collection, record_id, value_json, record_json, deleted, updated_at
      FROM photon_engine_records
      WHERE scope = $1
        AND collection = $2
        AND record_id = $3
        AND ($4 OR deleted = FALSE)
      LIMIT 1
    `,
    [engineScope, collection, recordId, options.includeDeleted ?? false]
  )
  return result.rows[0] ? toEngineRecord<T>(result.rows[0]) : null
}

export async function upsertClientEngineRecord<T>(
  collection: string,
  recordId: string,
  value: T
): Promise<PhotonEngineRecord<T>> {
  const record = await applyClientOperation<T>({
    collection,
    recordId,
    kind: 'upsert',
    value,
  })
  if (!record) throw new Error('Upsert unexpectedly deleted a Photon Engine record')
  return record
}

export async function patchClientEngineRecord<T>(
  collection: string,
  recordId: string,
  fields: object
): Promise<PhotonEngineRecord<T> | null> {
  return applyClientOperation<T>({
    collection,
    recordId,
    kind: 'patch',
    fields,
  })
}

export async function deleteClientEngineRecord(
  collection: string,
  recordId: string
): Promise<void> {
  await applyClientOperation({
    collection,
    recordId,
    kind: 'delete',
  })
}

export async function syncClientEngineOperations(
  apiBaseUrl = appKitConfig.server.apiBaseUrl ?? ''
): Promise<{ pushed: number; accepted: number }> {
  // Server sync is intentionally transport-agnostic: Web and Tauri both store
  // pending Engine operations in PGlite, then POST the shared JSON protocol.
  const db = await dbPromise
  const pending = await db.query<PhotonEngineOperationRow>(
    `
      SELECT operation_id, operation_json, status
      FROM photon_engine_operations
      WHERE scope = $1 AND status = 'pending'
      ORDER BY local_sequence ASC
    `,
    [engineScope]
  )
  if (pending.rows.length === 0) {
    return { pushed: 0, accepted: 0 }
  }
  const normalizedPending = pending.rows.map((row) => ({
    ...row,
    operation: normalizeEngineOperation(row.operation_json),
  }))

  const response = await fetch(`${apiBaseUrl}${appKitConfig.engine.pushPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: engineScope,
      operations: normalizedPending.map((row) => row.operation),
      cursor: null,
    }),
  })
  if (!response.ok) {
    throw new Error(`Photon Engine push failed: ${response.status}`)
  }

  const result = await response.json() as {
    decisions?: Array<{
      type: string
      operation_id: string
      remote_sequence?: number
    }>
  }
  let accepted = 0
  for (const decision of result.decisions ?? []) {
    if (decision.type !== 'accepted') continue
    accepted += 1
    await db.query(
      `
        UPDATE photon_engine_operations
        SET status = 'accepted'
        WHERE scope = $1 AND operation_id = $2
      `,
      [engineScope, decision.operation_id]
    )
  }

  await Promise.all(
    normalizedPending.map((row) =>
      db.query(
        `
          UPDATE photon_engine_operations
          SET operation_json = $1
          WHERE scope = $2 AND operation_id = $3
        `,
        [
          JSON.stringify(row.operation),
          engineScope,
          row.operation_id,
        ]
      )
    )
  )

  return { pushed: pending.rows.length, accepted }
}

function emptyOperationCounts(): ClientEngineDebugState['operations'] {
  return {
    pending: 0,
    accepted: 0,
    rejected: 0,
    conflict: 0,
    total: 0,
  }
}

export async function getClientEngineDebugState(): Promise<ClientEngineDebugState> {
  const db = await dbPromise
  const [recordCounts, operationCounts, recentOperations] = await Promise.all([
    db.query<PhotonEngineRecordCountRow>(
      `
        SELECT COUNT(*)::int AS count
        FROM photon_engine_records
        WHERE scope = $1 AND deleted = FALSE
      `,
      [engineScope]
    ),
    db.query<PhotonEngineStatusCountRow>(
      `
        SELECT status, COUNT(*)::int AS count
        FROM photon_engine_operations
        WHERE scope = $1
        GROUP BY status
      `,
      [engineScope]
    ),
    db.query<PhotonEngineOperationDebugRow>(
      `
        SELECT local_sequence, operation_id, operation_json, status, collection, record_id, created_at
        FROM photon_engine_operations
        WHERE scope = $1
        ORDER BY local_sequence DESC
        LIMIT 20
      `,
      [engineScope]
    ),
  ])

  const operations = emptyOperationCounts()
  for (const row of operationCounts.rows) {
    const status = row.status as keyof ClientEngineDebugState['operations']
    if (status in operations) {
      operations[status] = Number(row.count)
    }
    operations.total += Number(row.count)
  }

  return {
    scope: engineScope,
    records: Number(recordCounts.rows[0]?.count ?? 0),
    operations,
    recentOperations: recentOperations.rows.map((row) => {
      const operation = normalizeEngineOperation(row.operation_json)
      return {
        operationId: row.operation_id,
        collection: row.collection,
        recordId: row.record_id,
        status: row.status,
        localSequence: Number(row.local_sequence),
        createdAt: row.created_at,
        kind: operationKindLabel(operation.kind),
      }
    }),
  }
}

export const __testOnly = {
  applyClientOperationInPgliteForTests,
}
