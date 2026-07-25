import { useEffect, useMemo, useState } from 'react'
import {
  createDocumentCollaboration,
  type DocumentCollaboration,
  type DocumentSyncStatus,
} from './docYjs'

export function useDocumentCollaboration(docId: string) {
  const [collab, setCollab] = useState<DocumentCollaboration | null>(null)
  const [syncStatus, setSyncStatus] = useState<DocumentSyncStatus>('connecting')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let disposed = false
    const nextCollab = createDocumentCollaboration(docId, setSyncStatus)

    queueMicrotask(() => {
      if (!disposed) {
        setCollab(nextCollab)
      }
    })

    nextCollab.synced.then(() => {
      if (!disposed) {
        setReady(true)
      }
    })

    return () => {
      disposed = true
      nextCollab.destroy()
    }
  }, [docId])

  return useMemo(
    () => ({
      collab,
      ready,
      syncStatus,
      roomId: collab?.roomId ?? null,
    }),
    [collab, ready, syncStatus]
  )
}
