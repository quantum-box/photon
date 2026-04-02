import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'

// ---------------------------------------------------------------------------
// Y.Doc singleton
// ---------------------------------------------------------------------------

export const ydoc = new Y.Doc()
export const issuesArray = ydoc.getArray<Y.Map<string>>('issues')

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

export const persistence = new IndexeddbPersistence('tachyon-issues', ydoc)

/** Resolves when the local IndexedDB state has been loaded into the Y.Doc. */
export const idbSynced: Promise<void> = new Promise((resolve) => {
  persistence.once('synced', () => resolve())
})

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

type StatusListener = (status: ConnectionStatus) => void

let _status: ConnectionStatus = 'disconnected'
const _listeners = new Set<StatusListener>()

function setStatus(s: ConnectionStatus) {
  if (s === _status) return
  _status = s
  _listeners.forEach((fn) => fn(s))
}

export const connectionStatus = {
  get value() {
    return _status
  },
  subscribe(fn: StatusListener) {
    _listeners.add(fn)
    return () => {
      _listeners.delete(fn)
    }
  },
}

// ---------------------------------------------------------------------------
// WebSocket sync
// ---------------------------------------------------------------------------

const WS_REMOTE = 'ws-remote'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoff = 1000
const MAX_BACKOFF = 30_000
let disposed = false

function getWsUrl(): string {
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}/ws`
}

function scheduleReconnect() {
  if (disposed) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWs()
  }, backoff)
  backoff = Math.min(backoff * 2, MAX_BACKOFF)
}

/** Send local Y.Doc updates to the server (skip remote-origin updates). */
function onDocUpdate(update: Uint8Array, origin: unknown) {
  if (origin === WS_REMOTE) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(update)
  }
}

export function connectWs() {
  if (disposed) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  setStatus('connecting')

  const socket = new WebSocket(getWsUrl())
  socket.binaryType = 'arraybuffer'
  ws = socket

  let isFirstMessage = true

  socket.addEventListener('open', () => {
    backoff = 1000 // reset backoff on successful connect
    setStatus('connected')
    ydoc.on('update', onDocUpdate)
  })

  socket.addEventListener('message', (event) => {
    const data = new Uint8Array(event.data as ArrayBuffer)
    Y.applyUpdate(ydoc, data, WS_REMOTE)

    if (isFirstMessage) {
      isFirstMessage = false
      // Send our full local state so the server gets any offline changes
      const localUpdate = Y.encodeStateAsUpdate(ydoc)
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(localUpdate)
      }
    }
  })

  socket.addEventListener('close', () => {
    ydoc.off('update', onDocUpdate)
    ws = null
    setStatus('disconnected')
    scheduleReconnect()
  })

  socket.addEventListener('error', () => {
    // The 'close' event will fire after 'error', so reconnect is handled there.
  })
}

export function disconnectWs() {
  disposed = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  ydoc.off('update', onDocUpdate)
  if (ws) {
    ws.close()
    ws = null
  }
  setStatus('disconnected')
}

// ---------------------------------------------------------------------------
// Initial sync ready
// ---------------------------------------------------------------------------

/**
 * Resolves once:
 *  1. IndexedDB has been loaded, AND
 *  2. Either the first WebSocket message has been received, or 2 s elapsed
 *     (to support the offline-first case where the server is unreachable).
 */
export const initialSyncReady: Promise<void> = new Promise((resolve) => {
  let idbDone = false
  let wsDone = false
  let resolved = false

  function tryResolve() {
    if (resolved) return
    if (idbDone && wsDone) {
      resolved = true
      resolve()
    }
  }

  idbSynced.then(() => {
    idbDone = true
    tryResolve()

    // If WS hasn't delivered anything in 2 s, proceed anyway (offline)
    setTimeout(() => {
      wsDone = true
      tryResolve()
    }, 2000)
  })

  // Mark WS done as soon as the first message is applied
  const handler = (_update: Uint8Array, origin: unknown) => {
    if (origin === WS_REMOTE) {
      wsDone = true
      ydoc.off('update', handler)
      tryResolve()
    }
  }
  ydoc.on('update', handler)
})

// ---------------------------------------------------------------------------
// Auto-connect
// ---------------------------------------------------------------------------

connectWs()
