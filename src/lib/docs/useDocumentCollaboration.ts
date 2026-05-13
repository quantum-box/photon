import { useEffect, useMemo, useState } from 'react'
import {
  createDocumentCollaboration,
  type DocumentCollaboration,
  type DocumentSyncStatus,
} from './docYjs'

export function useDocumentCollaboration(docId: string) {
  const [syncStatus, setSyncStatus] = useState<DocumentSyncStatus>('connecting')
  const [collab] = useState<DocumentCollaboration>(() =>
    createDocumentCollaboration(docId, setSyncStatus)
  )
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let disposed = false

    collab.synced.then(() => {
      if (!disposed) {
        setReady(true)
      }
    })

    return () => {
      disposed = true
      collab.destroy()
    }
  }, [collab])

  return useMemo(
    () => ({
      collab,
      ready,
      syncStatus,
      roomId: collab.roomId,
    }),
    [collab, ready, syncStatus]
  )
}
