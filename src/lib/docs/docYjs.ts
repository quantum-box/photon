import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  appKitConfig,
  buildConfiguredSyncWebsocketUrl,
  buildRoomId,
  buildSyncWebsocketPath,
} from '../../app/kitConfig'
import type { DocBlock, DocBlockType } from './types'

export type DocumentSyncStatus = 'connecting' | 'connected' | 'offline'

export interface DocumentCollaboration {
  doc: Y.Doc
  blocks: Y.Array<Y.Map<string | boolean>>
  fragment: Y.XmlFragment
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
const MAX_BACKOFF = 30_000

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

export function createDocumentCollaboration(
  docId: string,
  onStatus?: (status: DocumentSyncStatus) => void
): DocumentCollaboration {
  const doc = new Y.Doc()
  const roomId = buildRoomId(appKitConfig.workspace.id, `doc:${docId}`)
  const blocks = doc.getArray<Y.Map<string | boolean>>(appKitConfig.docs.yjsArrayName)
  const fragment = doc.getXmlFragment('document-store')
  const persistence = new IndexeddbPersistence(roomId, doc)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 1000
  let disposed = false
  let remoteSynced = false

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

  function connectWs() {
    if (disposed) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    setStatus('connecting')
    const socket = new WebSocket(getWsUrl(roomId))
    socket.binaryType = 'arraybuffer'
    ws = socket

    socket.addEventListener('open', () => {
      backoff = 1000
      setStatus('connected')
      doc.on('update', onDocUpdate)
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return

      const data = new Uint8Array(event.data as ArrayBuffer)
      Y.applyUpdate(doc, data, WS_REMOTE)

      if (!remoteSynced) {
        remoteSynced = true
        const localUpdate = Y.encodeStateAsUpdate(doc)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(localUpdate)
        }
      }
    })

    socket.addEventListener('close', () => {
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
    persistence.once('synced', () => {
      let resolved = false
      const finishInitialSync = () => {
        if (resolved) return
        resolved = true
        clearTimeout(fallbackTimer)
        doc.off('update', handler)
        doc.transact(() => seedDefaultBlocks(blocks))
        resolve()
      }

      const fallbackTimer = setTimeout(() => {
        finishInitialSync()
      }, 1200)

      const handler = (_update: Uint8Array, origin: unknown) => {
        if (origin !== WS_REMOTE) return
        finishInitialSync()
      }

      doc.on('update', handler)
    })
  })

  connectWs()
  window.addEventListener('online', connectWs)
  document.addEventListener('visibilitychange', reconnectWhenVisible)

  return {
    doc,
    blocks,
    fragment,
    roomId,
    synced,
    destroy: () => {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
      doc.off('update', onDocUpdate)
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
