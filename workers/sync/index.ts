import { DurableObject } from 'cloudflare:workers'
import * as Y from 'yjs'

export interface Env {
  PHOTON_SYNC_ROOMS: DurableObjectNamespace<PhotonSyncRoom>
  PHOTON_CLOUD_ENGINE_BASE_URL?: string
  PHOTON_EDGE_SERVICE_TOKEN?: string
}

const DEFAULT_ROOM_ID = 'records'
const DEFAULT_CLOUD_ENGINE_BASE_URL = 'http://127.0.0.1:3001'
const SNAPSHOT_KEY = 'yjs:snapshot:bytes'
const SNAPSHOT_META_KEY = 'yjs:snapshot:meta'
const UPDATE_META_KEY = 'yjs:update:meta'
const UPDATE_KEY_PREFIX = 'yjs:update:'
const ENGINE_PROXY_PATHS = new Set([
  '/api/engine/push',
  '/api/engine/pull',
  '/api/engine/debug',
])
const MAX_PROXY_BODY_BYTES = 1024 * 1024
const EDGE_LOG_LIMIT = 100

// Compact the on-disk update log into a snapshot once the log exceeds this
// many rows. Keeps replay cost bounded for long-lived rooms.
const COMPACTION_THRESHOLD = 50

// Cloudflare DO storage caps a single value at 128 KiB. Reserve some
// headroom for serialization overhead; if the encoded snapshot exceeds
// the limit we keep replaying the log instead of writing a too-large value.
const MAX_SNAPSHOT_BYTES = 128 * 1024 - 4096
const MAX_UPDATE_BYTES = MAX_SNAPSHOT_BYTES

interface SnapshotMeta {
  seq: number
  byteLength: number
  updatedAt: string
}

interface UpdateMeta {
  /** Seq to assign to the next update written. */
  nextSeq: number
  /** Smallest seq still present in the log (entries below this were rolled
   * into the snapshot). */
  oldestSeq: number
}

interface EdgeSyncLog {
  id: string
  requestId: string
  timestamp: string
  method: string
  path: string
  target: string
  status: number
  durationMs: number
  requestBytes: number
  responseBytes: number
  ok: boolean
  error?: string
}

const edgeSyncLogs: EdgeSyncLog[] = []

function paddedSeq(seq: number): string {
  // 12 zero-padded digits keeps lexicographic sort == numeric sort up to
  // ~10^12 updates per room, which is comfortably beyond any realistic
  // lifetime for a single room.
  return seq.toString().padStart(12, '0')
}

function updateKey(seq: number): string {
  return `${UPDATE_KEY_PREFIX}${paddedSeq(seq)}`
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-request-id,x-photon-request-id',
    'access-control-expose-headers': 'x-photon-request-id',
  }
}

function requestId(request: Request): string {
  return request.headers.get('x-photon-request-id') ||
    request.headers.get('x-request-id') ||
    `edge_${crypto.randomUUID()}`
}

function cloudEngineBaseUrl(env: Env): string {
  return (env.PHOTON_CLOUD_ENGINE_BASE_URL || DEFAULT_CLOUD_ENGINE_BASE_URL).replace(/\/$/, '')
}

function appendEdgeLog(log: EdgeSyncLog) {
  edgeSyncLogs.unshift(log)
  edgeSyncLogs.splice(EDGE_LOG_LIMIT)
  console.info(
    `[photon-edge] ${log.method} ${log.path} -> ${log.status} ` +
      `${log.durationMs}ms request_id=${log.requestId}`,
  )
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value)
  }
  return new Response(JSON.stringify(payload), { ...init, headers })
}

async function proxyEngineRequest(request: Request, env: Env, path: string): Promise<Response> {
  const startedAt = Date.now()
  const id = requestId(request)
  const target = `${cloudEngineBaseUrl(env)}${path}`
  let requestBytes = 0

  try {
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    requestBytes = body?.byteLength ?? 0
    if (requestBytes > MAX_PROXY_BODY_BYTES) {
      const status = 413
      appendEdgeLog({
        id: crypto.randomUUID(),
        requestId: id,
        timestamp: new Date().toISOString(),
        method: request.method,
        path,
        target,
        status,
        durationMs: Date.now() - startedAt,
        requestBytes,
        responseBytes: 0,
        ok: false,
        error: 'request body too large',
      })
      return jsonResponse({ error: 'request body too large', maxBytes: MAX_PROXY_BODY_BYTES }, { status })
    }

    const headers = new Headers()
    headers.set('content-type', request.headers.get('content-type') || 'application/json')
    headers.set('x-photon-request-id', id)
    if (env.PHOTON_EDGE_SERVICE_TOKEN) {
      headers.set('authorization', `Bearer ${env.PHOTON_EDGE_SERVICE_TOKEN}`)
    }

    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
    })
    const responseBody = await response.arrayBuffer()
    const responseHeaders = new Headers(response.headers)
    responseHeaders.set('x-photon-request-id', id)
    for (const [key, value] of Object.entries(corsHeaders())) {
      responseHeaders.set(key, value)
    }

    appendEdgeLog({
      id: crypto.randomUUID(),
      requestId: id,
      timestamp: new Date().toISOString(),
      method: request.method,
      path,
      target,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestBytes,
      responseBytes: responseBody.byteLength,
      ok: response.ok,
    })

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendEdgeLog({
      id: crypto.randomUUID(),
      requestId: id,
      timestamp: new Date().toISOString(),
      method: request.method,
      path,
      target,
      status: 502,
      durationMs: Date.now() - startedAt,
      requestBytes,
      responseBytes: 0,
      ok: false,
      error: message,
    })
    return jsonResponse({ error: 'cloud engine proxy failed', detail: message }, { status: 502 })
  }
}

function presenceMessage(onlineCount: number): string {
  return JSON.stringify({ type: 'presence', onlineCount })
}

function getRoomId(request: Request): string {
  const url = new URL(request.url)
  return url.searchParams.get('room') || DEFAULT_ROOM_ID
}

function toUint8Array(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

/** Returns a fresh ArrayBuffer that exactly fits the input bytes. DO storage
 * stores ArrayBuffer values; if we hand it a Uint8Array view over a larger
 * buffer the storage layer would persist the entire underlying buffer. */
function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (url.pathname === '/__debug/sync') {
      return jsonResponse({
        edge: {
          status: 'ok',
          role: 'photon-edge-worker',
          cloudEngineBaseUrl: cloudEngineBaseUrl(env),
          engineProxyPaths: Array.from(ENGINE_PROXY_PATHS),
          logLimit: EDGE_LOG_LIMIT,
        },
        logs: edgeSyncLogs,
      })
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({
        status: 'ok',
        backend: 'cloudflare-durable-object',
        edge: 'photon-edge-worker',
        cloudEngineBaseUrl: cloudEngineBaseUrl(env),
      })
    }

    if (ENGINE_PROXY_PATHS.has(url.pathname)) {
      return proxyEngineRequest(request, env, url.pathname)
    }

    if (url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 })
    }

    const id = env.PHOTON_SYNC_ROOMS.idFromName(getRoomId(request))
    return env.PHOTON_SYNC_ROOMS.get(id).fetch(request)
  },
}

export class PhotonSyncRoom extends DurableObject<Env> {
  /** Cached, lazily-hydrated Y.Doc for this DO instance. The DO can be
   * evicted under hibernation, in which case the next message arrives at
   * a fresh instance with this field reset to null and we rehydrate from
   * persisted snapshot + log. */
  private docPromise: Promise<Y.Doc> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server)
    await this.sendInitialSnapshot(server)
    this.broadcastPresence()

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(sender: WebSocket, message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message === 'string') {
      this.broadcastAwareness(sender, message)
      return
    }

    const bytes = toUint8Array(message)
    const accepted = await this.tryApplyAndPersist(bytes)
    if (!accepted) return

    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== sender) {
        socket.send(bytes)
      }
    }
  }

  webSocketClose(socket: WebSocket) {
    this.broadcastPresence(socket)
  }

  webSocketError(socket: WebSocket) {
    this.broadcastPresence(socket)
  }

  private ensureDoc(): Promise<Y.Doc> {
    if (!this.docPromise) {
      this.docPromise = this.hydrateDoc()
    }
    return this.docPromise
  }

  private async hydrateDoc(): Promise<Y.Doc> {
    const doc = new Y.Doc()
    let snapshotSeq = 0
    let applied = 0
    let skipped = 0

    const snapshotBytes = await this.ctx.storage.get<ArrayBuffer>(SNAPSHOT_KEY)
    const snapshotMeta = await this.ctx.storage.get<SnapshotMeta>(SNAPSHOT_META_KEY)
    if (snapshotBytes && snapshotMeta) {
      try {
        Y.applyUpdate(doc, new Uint8Array(snapshotBytes))
        snapshotSeq = snapshotMeta.seq
      } catch (err) {
        console.warn('[photon-sync] corrupt snapshot, starting fresh', err)
      }
    }

    const updateMeta = (await this.ctx.storage.get<UpdateMeta>(UPDATE_META_KEY)) ?? {
      nextSeq: snapshotSeq + 1,
      oldestSeq: snapshotSeq + 1,
    }

    if (updateMeta.nextSeq > updateMeta.oldestSeq) {
      // list() returns entries lexicographically; padded keys ensure that
      // matches numeric seq order.
      const stored = await this.ctx.storage.list<ArrayBuffer>({
        start: updateKey(updateMeta.oldestSeq),
        end: updateKey(updateMeta.nextSeq),
      })
      for (const [key, bytes] of stored) {
        try {
          Y.applyUpdate(doc, new Uint8Array(bytes))
          applied++
        } catch (err) {
          skipped++
          console.warn(`[photon-sync] skipping corrupt stored update ${key}`, err)
        }
      }
    }

    console.info(
      `[photon-sync] hydrated DO room: snapshotSeq=${snapshotSeq} ` +
        `nextSeq=${updateMeta.nextSeq} applied=${applied} skipped=${skipped}`,
    )

    return doc
  }

  private async sendInitialSnapshot(socket: WebSocket) {
    const doc = await this.ensureDoc()
    const snapshot = Y.encodeStateAsUpdate(doc)
    socket.send(snapshot)
  }

  private async tryApplyAndPersist(update: Uint8Array): Promise<boolean> {
    if (update.byteLength > MAX_UPDATE_BYTES) {
      console.warn(
        `[photon-sync] dropping oversized yjs update ${update.byteLength}B; ` +
          `limit is ${MAX_UPDATE_BYTES}B`,
      )
      return false
    }

    const doc = await this.ensureDoc()

    try {
      Y.applyUpdate(doc, update)
    } catch (err) {
      console.warn('[photon-sync] dropping malformed client update', err)
      return false
    }

    const meta = (await this.ctx.storage.get<UpdateMeta>(UPDATE_META_KEY)) ?? {
      nextSeq: 1,
      oldestSeq: 1,
    }
    const seq = meta.nextSeq
    meta.nextSeq = seq + 1
    if (seq < meta.oldestSeq) meta.oldestSeq = seq

    await this.ctx.storage.put({
      [updateKey(seq)]: toOwnedArrayBuffer(update),
      [UPDATE_META_KEY]: meta,
    })

    if (meta.nextSeq - meta.oldestSeq > COMPACTION_THRESHOLD) {
      await this.compact(doc, seq)
    }

    return true
  }

  /**
   * Roll the in-memory doc into a fresh snapshot, persist it, and delete
   * the update rows it covers. Done inside `ctx.storage.transaction` so
   * that an aborted compaction never leaves the room with a stale
   * snapshot pointing past deleted log entries.
   */
  private async compact(doc: Y.Doc, throughSeq: number) {
    const snapshot = Y.encodeStateAsUpdate(doc)
    if (snapshot.byteLength > MAX_SNAPSHOT_BYTES) {
      console.warn(
        `[photon-sync] snapshot ${snapshot.byteLength}B exceeds limit ` +
          `${MAX_SNAPSHOT_BYTES}B, skipping compaction`,
      )
      return
    }

    const snapshotMeta: SnapshotMeta = {
      seq: throughSeq,
      byteLength: snapshot.byteLength,
      updatedAt: new Date().toISOString(),
    }

    await this.ctx.storage.transaction(async (txn) => {
      const updateMeta = (await txn.get<UpdateMeta>(UPDATE_META_KEY)) ?? {
        nextSeq: throughSeq + 1,
        oldestSeq: 1,
      }

      const keysToDelete: string[] = []
      for (let i = updateMeta.oldestSeq; i <= throughSeq; i++) {
        keysToDelete.push(updateKey(i))
      }
      updateMeta.oldestSeq = throughSeq + 1
      if (updateMeta.nextSeq < updateMeta.oldestSeq) {
        updateMeta.nextSeq = updateMeta.oldestSeq
      }

      await txn.put({
        [SNAPSHOT_KEY]: toOwnedArrayBuffer(snapshot),
        [SNAPSHOT_META_KEY]: snapshotMeta,
        [UPDATE_META_KEY]: updateMeta,
      })

      if (keysToDelete.length > 0) {
        await txn.delete(keysToDelete)
      }
    })

    console.info(
      `[photon-sync] compacted yjs log through seq ${throughSeq}, ` +
        `snapshot ${snapshot.byteLength}B`,
    )
  }

  private broadcastPresence(excludedSocket?: WebSocket) {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== excludedSocket)
    const message = presenceMessage(sockets.length)

    for (const socket of sockets) {
      socket.send(message)
    }
  }

  private broadcastAwareness(sender: WebSocket, message: string) {
    try {
      const parsed = JSON.parse(message) as { type?: string }
      if (parsed.type !== 'awareness') return
    } catch {
      return
    }

    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== sender) {
        socket.send(message)
      }
    }
  }
}
