import { DurableObject } from 'cloudflare:workers'

export interface Env {
  PHOTON_SYNC_ROOMS: DurableObjectNamespace<PhotonSyncRoom>
}

const DEFAULT_ROOM_ID = 'issues'
const UPDATE_LOG_META_KEY = 'yjs-update-log-meta'
const UPDATE_KEY_PREFIX = 'yjs-update'
const MAX_STORED_UPDATES = 500

interface UpdateLogMeta {
  nextId: number
  keys: string[]
}

function presenceMessage(onlineCount: number): string {
  return JSON.stringify({ type: 'presence', onlineCount })
}

function getRoomId(request: Request): string {
  const url = new URL(request.url)
  return url.searchParams.get('room') || DEFAULT_ROOM_ID
}

function toBytes(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok', backend: 'cloudflare-durable-object' })
    }

    if (url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 })
    }

    const id = env.PHOTON_SYNC_ROOMS.idFromName(getRoomId(request))
    return env.PHOTON_SYNC_ROOMS.get(id).fetch(request)
  },
}

export class PhotonSyncRoom extends DurableObject<Env> {
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
    await this.sendStoredUpdates(server)
    this.broadcastPresence()

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(sender: WebSocket, message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message === 'string') return

    const bytes = toBytes(message)
    await this.appendUpdate(bytes)

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

  private async sendStoredUpdates(socket: WebSocket) {
    const meta = await this.getUpdateLogMeta()

    for (const key of meta.keys) {
      const update = await this.ctx.storage.get<ArrayBuffer>(key)
      if (update) {
        socket.send(update)
      }
    }
  }

  private async appendUpdate(update: Uint8Array) {
    const meta = await this.getUpdateLogMeta()
    const key = `${UPDATE_KEY_PREFIX}:${meta.nextId}`
    const storedBytes = new Uint8Array(update.byteLength)
    storedBytes.set(update)
    const storedUpdate = storedBytes.buffer

    meta.keys.push(key)
    meta.nextId += 1

    const expiredKeys =
      meta.keys.length > MAX_STORED_UPDATES
        ? meta.keys.splice(0, meta.keys.length - MAX_STORED_UPDATES)
        : []

    const writes: Record<string, ArrayBuffer | UpdateLogMeta> = {
      [key]: storedUpdate,
      [UPDATE_LOG_META_KEY]: meta,
    }

    await this.ctx.storage.put(writes)
    await Promise.all(expiredKeys.map((expiredKey) => this.ctx.storage.delete(expiredKey)))
  }

  private async getUpdateLogMeta(): Promise<UpdateLogMeta> {
    return (
      (await this.ctx.storage.get<UpdateLogMeta>(UPDATE_LOG_META_KEY)) ?? {
        nextId: 1,
        keys: [],
      }
    )
  }

  private broadcastPresence(excludedSocket?: WebSocket) {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== excludedSocket)
    const message = presenceMessage(sockets.length)

    for (const socket of sockets) {
      socket.send(message)
    }
  }
}
