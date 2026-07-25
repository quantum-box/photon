import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness'
import {
  appKitConfig,
  buildConfiguredSyncWebsocketUrl,
  buildRoomId,
  buildSyncWebsocketPath,
} from '../../app/kitConfig'
import type { DocBlock, DocBlockType } from './types'

// Photon Live for document bodies. Yjs/IndexedDB/WebSocket keep the editor
// responsive and collaborative; Photon Engine stores durable metadata,
// snapshots, and update streams through the application server.

export type DocumentSyncStatus = 'connecting' | 'connected' | 'offline'

export interface DocumentCollaboration {
  doc: Y.Doc
  blocks: Y.Array<Y.Map<string | boolean>>
  fragment: Y.XmlFragment
  provider: { awareness: Awareness }
  user: { name: string; color: string }
  roomId: string
  synced: Promise<void>
  destroy: () => void
}

export const blockTypes: Array<{ type: DocBlockType; label: string }> = [
  { type: 'paragraph', label: 'Text' },
  { type: 'heading', label: 'Heading' },
  { type: 'checklist', label: 'Check' },
  { type: 'quote', label: 'Quote' },
  { type: 'code', label: 'Code' },
  { type: 'divider', label: 'Divider' },
  { type: 'table', label: 'Table' },
]

function createBlockMap(block: DocBlock): Y.Map<string | boolean> {
  const map = new Y.Map<string | boolean>()
  map.set('id', block.id)
  map.set('type', block.type)
  map.set('text', block.text)
  map.set('checked', block.checked)
  map.set('language', block.language)
  return map
}

export function createBlock(type: DocBlockType = 'paragraph', text = ''): DocBlock {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    text,
    checked: false,
    language: type === 'code' ? 'typescript' : '',
  }
}

export function yMapToBlock(map: Y.Map<string | boolean>): DocBlock {
  return {
    id: String(map.get('id') ?? ''),
    type: (map.get('type') as DocBlockType | undefined) ?? 'paragraph',
    text: String(map.get('text') ?? ''),
    checked: map.get('checked') === true,
    language: String(map.get('language') ?? ''),
  }
}

const WS_REMOTE = 'docs-ws-remote'
const AWARENESS_REMOTE = 'docs-awareness-remote'
const LOCAL_USER_KEY = 'photon:docs:collaboration-user'
const MAX_BACKOFF = 30_000
const activeDocumentSockets = new Set<WebSocket>()

declare global {
  interface Window {
    __photonTestHooks?: {
      closeDocumentSockets?: () => void
    }
  }
}

type SyncTextMessage =
  | { type: 'presence'; onlineCount: number }
  | { type: 'awareness'; update: string }

function getWsUrl(roomId: string): string {
  const configuredUrl = buildConfiguredSyncWebsocketUrl(roomId)
  if (configuredUrl) {
    return configuredUrl
  }

  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}${buildSyncWebsocketPath(roomId)}`
}

function seedDefaultBlocks(blocks: Y.Array<Y.Map<string | boolean>>) {
  if (blocks.length > 0) return
  blocks.push([
    createBlockMap(createBlock('heading', 'New document')),
    createBlockMap(createBlock('paragraph', '')),
  ])
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function getLocalUser(): { name: string; color: string } {
  const fallback = {
    name: `Photon ${Math.floor(Math.random() * 900 + 100)}`,
    color: '#5b5bf7',
  }

  try {
    const stored = window.localStorage.getItem(LOCAL_USER_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<typeof fallback>
      if (parsed.name && parsed.color) {
        return { name: parsed.name, color: parsed.color }
      }
    }

    window.localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(fallback))
  } catch {
    // LocalStorage can be unavailable in restricted browser modes.
  }

  return fallback
}

function closeActiveDocumentSockets() {
  for (const socket of activeDocumentSockets) {
    socket.close()
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__photonTestHooks = {
    ...window.__photonTestHooks,
    closeDocumentSockets: closeActiveDocumentSockets,
  }
}

export function createDocumentCollaboration(
  docId: string,
  onStatus?: (status: DocumentSyncStatus) => void
): DocumentCollaboration {
  const doc = new Y.Doc()
  const roomId = buildRoomId(appKitConfig.workspace.scope, `doc:${docId}`)
  const blocks = doc.getArray<Y.Map<string | boolean>>(appKitConfig.docs.yjsArrayName)
  const fragment = doc.getXmlFragment('document-store')
  const awareness = new Awareness(doc)
  const provider = { awareness }
  const user = getLocalUser()
  const persistence = new IndexeddbPersistence(roomId, doc)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 1000
  let disposed = false

  function setStatus(status: DocumentSyncStatus) {
    onStatus?.(status)
  }

  function scheduleReconnect() {
    if (disposed) return
    setStatus('connecting')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWs()
    }, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF)
  }

  function onDocUpdate(update: Uint8Array, origin: unknown) {
    if (origin === WS_REMOTE) return
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(update)
    }
  }

  function sendAwarenessUpdate(clientIds: number[]) {
    if (!clientIds.length || ws?.readyState !== WebSocket.OPEN) return

    const update = encodeAwarenessUpdate(awareness, clientIds)
    const message: SyncTextMessage = {
      type: 'awareness',
      update: bytesToBase64(update),
    }
    ws.send(JSON.stringify(message))
  }

  function onAwarenessUpdate(
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) {
    if (origin === AWARENESS_REMOTE) return
    sendAwarenessUpdate([...changes.added, ...changes.updated, ...changes.removed])
  }

  function connectWs() {
    if (disposed) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    setStatus('connecting')
    const socket = new WebSocket(getWsUrl(roomId))
    socket.binaryType = 'arraybuffer'
    ws = socket
    activeDocumentSockets.add(socket)
    let isFirstRemoteUpdate = true

    socket.addEventListener('open', () => {
      backoff = 1000
      setStatus('connected')
      doc.on('update', onDocUpdate)
      socket.send(Y.encodeStateAsUpdate(doc))
      sendAwarenessUpdate([awareness.clientID])
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as Partial<SyncTextMessage>
          if (message.type === 'awareness' && typeof message.update === 'string') {
            applyAwarenessUpdate(awareness, base64ToBytes(message.update), AWARENESS_REMOTE)
          }
        } catch {
          // Ignore non-protocol text messages such as presence updates.
        }
        return
      }

      const data = new Uint8Array(event.data as ArrayBuffer)
      Y.applyUpdate(doc, data, WS_REMOTE)

      if (isFirstRemoteUpdate) {
        isFirstRemoteUpdate = false
        const localUpdate = Y.encodeStateAsUpdate(doc)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(localUpdate)
        }
      }
    })

    socket.addEventListener('close', () => {
      activeDocumentSockets.delete(socket)
      doc.off('update', onDocUpdate)
      ws = null
      setStatus('offline')
      scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      setStatus('offline')
    })
  }

  function reconnectWhenVisible() {
    if (document.visibilityState === 'visible') {
      connectWs()
    }
  }

  const synced = new Promise<void>((resolve) => {
    let resolved = false
    const fallbackTimer = setTimeout(() => {
      finishInitialSync()
    }, 1200)

    const finishInitialSync = () => {
      if (resolved) return
      resolved = true
      clearTimeout(fallbackTimer)
      doc.off('update', handler)
      doc.transact(() => seedDefaultBlocks(blocks))
      resolve()
    }

    const handler = (_update: Uint8Array, origin: unknown) => {
      if (origin !== WS_REMOTE) return
      finishInitialSync()
    }

    persistence.once('synced', finishInitialSync)
    doc.on('update', handler)
  })

  connectWs()
  awareness.on('update', onAwarenessUpdate)
  window.addEventListener('online', connectWs)
  document.addEventListener('visibilitychange', reconnectWhenVisible)

  return {
    doc,
    blocks,
    fragment,
    provider,
    user,
    roomId,
    synced,
    destroy: () => {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
      doc.off('update', onDocUpdate)
      if (ws?.readyState === WebSocket.OPEN) {
        awareness.setLocalState(null)
        sendAwarenessUpdate([awareness.clientID])
      }
      awareness.off('update', onAwarenessUpdate)
      if (ws) {
        ws.close()
      }
      window.removeEventListener('online', connectWs)
      document.removeEventListener('visibilitychange', reconnectWhenVisible)
      persistence.destroy()
      doc.destroy()
    },
  }
}

export function insertBlock(
  blocks: Y.Array<Y.Map<string | boolean>>,
  index: number,
  block: DocBlock
) {
  blocks.insert(index, [createBlockMap(block)])
}
