import { useEffect, useMemo, useState } from 'react'
import {
  createDocumentCollaboration,
  type DocumentCollaboration,
  type DocumentSyncStatus,
} from './docYjs'

export function useDocumentCollaboration(docId: string | null) {
  const [collab, setCollab] = useState<DocumentCollaboration | null>(null)
  const [ready, setReady] = useState(false)
  const [syncStatus, setSyncStatus] = useState<DocumentSyncStatus>('connecting')

  useEffect(() => {
    if (!docId) {
      setCollab(null)
      setReady(false)
      setSyncStatus('connecting')
      return
    }

    let disposed = false
    const nextCollab = createDocumentCollaboration(docId, setSyncStatus)
    setCollab(nextCollab)

    nextCollab.synced.then(() => {
      if (!disposed) {
        setReady(true)
      }
    })

    return () => {
      disposed = true
      nextCollab.destroy()
      setReady(false)
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
