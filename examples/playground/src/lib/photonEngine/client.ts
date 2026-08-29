/**
 * The playground's handle on the Photon engine.
 *
 * This used to be a 748-line reimplementation of the engine: its own PGlite
 * schema, its own WASM loading, its own Tauri `invoke` branch, its own sync
 * call, and a "fallback" that shallow-merged objects in JavaScript whenever the
 * WASM module failed to load — silently producing merges that were not CRDT
 * semantics at all.
 *
 * All of that now lives in `@quantum-box/photon`. What remains here is what an
 * application legitimately owns: which scope, which actor, where storage lives,
 * and how to authenticate.
 */

import {
  createEngineTransport,
  createPhotonClient,
  createSharedLocalStore,
  sharedStoreSupported,
  type LocalStore,
  type PhotonClient,
  type PhotonRecord,
} from '@quantum-box/photon-core'
import { createPGliteStore } from '@quantum-box/photon-store-pglite'
import { loadPhotonKernel } from '@quantum-box/photon-wasm'

import { appKitConfig } from '../../app/kitConfig'
import { getAuthToken } from '../auth/session'

export type PhotonEngineMutationKind = 'upsert' | 'patch' | 'delete'

/** The shape this app's own modules were already written against. */
export interface PhotonEngineRecord<T = unknown> {
  scope: string
  collection: string
  recordId: string
  value: T
  deleted: boolean
  updatedAt: string
  /** Not yet acknowledged by the server. */
  pending: boolean
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

const engineScope = appKitConfig.workspace.scope
const engineActorId = `${appKitConfig.tenant.id}:${appKitConfig.workspace.id}:${appKitConfig.app.id}-client`

let clientPromise: Promise<PhotonClient> | null = null

/** The single client for this workspace. Created lazily, reused thereafter. */
export function photonClient(): Promise<PhotonClient> {
  clientPromise ??= build()
  return clientPromise
}

/**
 * The client if something already asked for it, without triggering the build.
 * The realtime bridge in `yjsProvider` uses this: a WebSocket frame must never
 * be the thing that drags PGlite + WASM loading onto the first-paint path.
 */
export function peekPhotonClient(): Promise<PhotonClient> | null {
  return clientPromise
}

/**
 * One PGlite database, however many tabs.
 *
 * PGlite holds a single connection per data directory, and every tab of this
 * origin resolves `pgliteDataDir` to the same IndexedDB. Opening it in each
 * tab corrupts it, so exactly one tab opens it and the rest talk to that one;
 * when it closes, the next tab is promoted and opens the database itself.
 *
 * The in-memory case skips all of this: an unnamed database is private to the
 * context that created it, so there is nothing to share and nobody to share
 * it with.
 */
async function openStorage(durable: boolean): Promise<LocalStore> {
  const open = (): Promise<LocalStore> =>
    createPGliteStore(durable ? { dataDir: appKitConfig.engine.pgliteDataDir } : {})

  if (!durable || !sharedStoreSupported()) return open()

  return createSharedLocalStore({ key: appKitConfig.engine.pgliteDataDir, open })
}

async function build(): Promise<PhotonClient> {
  // PGlite's idb:// backend needs IndexedDB. jsdom has none, so unit tests run
  // against an in-memory database: durable within a test, not across a reload.
  const durable = typeof globalThis.indexedDB !== 'undefined'

  const [storage, kernel] = await Promise.all([openStorage(durable), loadPhotonKernel()])

  return createPhotonClient({
    scope: engineScope,
    actorId: engineActorId,
    storage,
    kernel,
    sync: {
      // The op-log is the read path now: React renders records straight from
      // the engine, so the sync loop runs for real. Push is debounced behind
      // mutations, pull rides the poll interval, and failures back off with
      // jitter — offline use degrades to local-only, not to an error state.
      autoStart: true,
    },
    transport: createEngineTransport({
      baseUrl: appKitConfig.server.apiBaseUrl ?? '',
      pushPath: appKitConfig.engine.pushPath,
      pullPath: appKitConfig.engine.pullPath,
      // The engine takes an auth hook, not an auth client: it must not know
      // which identity provider this application happens to use.
      headers: (): Record<string, string> => {
        const token = getAuthToken()
        return token ? { authorization: `Bearer ${token}` } : {}
      },
    }),
  })
}

function toEngineRecord<T>(record: PhotonRecord<T>): PhotonEngineRecord<T> {
  return {
    scope: record.key.scope,
    collection: record.key.collection,
    recordId: record.key.record_id,
    value: record.value,
    deleted: record.deletedAt !== null,
    updatedAt: new Date(record.version.wall_time_ms).toISOString(),
    pending: record.pending,
  }
}

export async function listClientEngineRecords<T>(
  collection: string,
): Promise<Array<PhotonEngineRecord<T>>> {
  const client = await photonClient()
  const query = client.query<T>({ collection })
  await query.ready()
  const records = query.getSnapshot().data.map(toEngineRecord)
  query.destroy()
  return records
}

export async function getClientEngineRecord<T>(
  collection: string,
  recordId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<PhotonEngineRecord<T> | null> {
  const client = await photonClient()
  const query = client.liveRecord<T>(collection, recordId)
  await query.ready()
  const record = query.getSnapshot().data
  query.destroy()
  if (!record) return null
  if (record.deletedAt && !options.includeDeleted) return null
  return toEngineRecord(record)
}

export async function upsertClientEngineRecord<T>(
  collection: string,
  recordId: string,
  value: T,
): Promise<PhotonEngineRecord<T>> {
  const client = await photonClient()
  const record = await client.upsert<T>(collection, recordId, value).local
  if (!record) throw new Error('Upsert unexpectedly deleted a Photon Engine record')
  return toEngineRecord(record)
}

export async function patchClientEngineRecord<T>(
  collection: string,
  recordId: string,
  fields: object,
): Promise<PhotonEngineRecord<T> | null> {
  const client = await photonClient()
  const record = await client.patch<T>(collection, recordId, fields as Partial<T>).local
  return record ? toEngineRecord(record) : null
}

export async function deleteClientEngineRecord(
  collection: string,
  recordId: string,
): Promise<void> {
  const client = await photonClient()
  await client.remove(collection, recordId).local
}

export async function syncClientEngineOperations(): Promise<{
  pushed: number
  pulled: number
}> {
  const client = await photonClient()
  const summary = await client.sync.syncNow('manual')
  return { pushed: summary.pushed, pulled: summary.pulled }
}

export async function getClientEngineDebugState(): Promise<ClientEngineDebugState> {
  const client = await photonClient()
  const stats = await client.storage.stats(engineScope)
  const { pending, accepted, rejected, conflict } = stats.operations

  return {
    scope: engineScope,
    records: Object.values(stats.recordsByCollection).reduce((sum, n) => sum + n, 0),
    operations: {
      pending,
      accepted,
      rejected,
      conflict,
      total: pending + accepted + rejected + conflict,
    },
    // The client no longer keeps a per-operation debug feed of its own; the
    // authoritative one is /api/engine/debug on the server.
    recentOperations: [],
  }
}
