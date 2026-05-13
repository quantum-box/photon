import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocMetadata } from './types'
import { createDoc, ensureDoc, listDocs, subscribeDocs, updateDoc } from './docsDb'

export function useDocs() {
  const [docs, setDocs] = useState<DocMetadata[]>([])
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    const nextDocs = await listDocs()
    setDocs(nextDocs)
    setReady(true)
  }, [])

  useEffect(() => {
    let cancelled = false

    refresh().catch((error: unknown) => {
      if (!cancelled) {
        console.warn('Failed to load local documents', error)
        setReady(true)
      }
    })

    const unsubscribe = subscribeDocs(() => {
      if (!cancelled) {
        void refresh()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [refresh])

  const createDocument = useCallback(async (title?: string) => {
    return createDoc({ title })
  }, [])

  const ensureDocument = useCallback(async (docId: string) => {
    return ensureDoc(docId)
  }, [])

  const renameDocument = useCallback(async (docId: string, title: string) => {
    return updateDoc(docId, { title })
  }, [])

  return useMemo(
    () => ({ docs, ready, refresh, createDocument, ensureDocument, renameDocument }),
    [docs, ready, refresh, createDocument, ensureDocument, renameDocument]
  )
}
