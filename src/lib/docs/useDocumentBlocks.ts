import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import {
  createBlock,
  createDocumentCollaboration,
  insertBlock,
  yMapToBlock,
  type DocumentSyncStatus,
} from './docYjs'
import { touchDoc } from './docsDb'
import type { DocBlock, DocBlockType } from './types'

function snapshot(blocks: Y.Array<Y.Map<string | boolean>>): DocBlock[] {
  const result: DocBlock[] = []
  blocks.forEach((block) => result.push(yMapToBlock(block)))
  return result
}

export function useDocumentBlocks(docId: string | null) {
  const [blocks, setBlocks] = useState<DocBlock[]>([])
  const [ready, setReady] = useState(false)
  const [syncStatus, setSyncStatus] = useState<DocumentSyncStatus>('connecting')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [collab, setCollab] = useState<ReturnType<typeof createDocumentCollaboration> | null>(null)

  useEffect(() => {
    if (!docId) {
      setBlocks([])
      setReady(false)
      setSyncStatus('connecting')
      setRoomId(null)
      setCollab(null)
      return
    }

    let disposed = false
    let rafId: number | null = null
    const nextCollab = createDocumentCollaboration(docId, setSyncStatus)
    setRoomId(nextCollab.roomId)

    function refresh() {
      if (disposed) return
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!disposed) {
          setBlocks(snapshot(nextCollab.blocks))
        }
      })
    }

    nextCollab.synced.then(() => {
      if (disposed) return
      setBlocks(snapshot(nextCollab.blocks))
      setReady(true)
      nextCollab.blocks.observeDeep(refresh)
    })

    setCollab(nextCollab)

    return () => {
      disposed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      nextCollab.blocks.unobserveDeep(refresh)
      nextCollab.destroy()
      setReady(false)
    }
  }, [docId])

  const mutate = useCallback(
    (fn: (blocks: Y.Array<Y.Map<string | boolean>>) => void) => {
      if (!collab || !docId) return
      collab.doc.transact(() => fn(collab.blocks))
      void touchDoc(docId)
    },
    [collab, docId]
  )

  const updateBlock = useCallback(
    (blockId: string, patch: Partial<Omit<DocBlock, 'id'>>) => {
      mutate((yBlocks) => {
        for (let index = 0; index < yBlocks.length; index++) {
          const block = yBlocks.get(index)
          if (block.get('id') !== blockId) continue
          Object.entries(patch).forEach(([key, value]) => {
            block.set(key, value)
          })
          return
        }
      })
    },
    [mutate]
  )

  const addBlockAfter = useCallback(
    (blockId: string | null, type: DocBlockType = 'paragraph') => {
      mutate((yBlocks) => {
        const nextBlock = createBlock(type)
        if (!blockId) {
          insertBlock(yBlocks, yBlocks.length, nextBlock)
          return
        }

        const index = blocks.findIndex((block) => block.id === blockId)
        insertBlock(yBlocks, index >= 0 ? index + 1 : yBlocks.length, nextBlock)
      })
    },
    [blocks, mutate]
  )

  const deleteBlock = useCallback(
    (blockId: string) => {
      mutate((yBlocks) => {
        if (yBlocks.length <= 1) return
        for (let index = 0; index < yBlocks.length; index++) {
          if (yBlocks.get(index).get('id') === blockId) {
            yBlocks.delete(index, 1)
            return
          }
        }
      })
    },
    [mutate]
  )

  return useMemo(
    () => ({ blocks, ready, syncStatus, roomId, updateBlock, addBlockAfter, deleteBlock }),
    [blocks, ready, syncStatus, roomId, updateBlock, addBlockAfter, deleteBlock]
  )
}
