import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocMetadata } from './types'
import { createDoc, ensureDoc, listDocs, subscribeDocs, updateDoc } from './docsDb'

export function useDocs() {
  const [docs, setDocs] = useState<DocMetadata[]>([])
  const [ready, setReady] = useState(false)

  const loadDocs = useCallback(async () => {
    return listDocs()
  }, [])

  const refresh = useCallback(async () => {
    const nextDocs = await loadDocs()
    setDocs(nextDocs)
    setReady(true)
  }, [loadDocs])

  useEffect(() => {
    let cancelled = false

    async function loadInitialDocs() {
      try {
        const nextDocs = await loadDocs()
        if (!cancelled) {
          setDocs(nextDocs)
          setReady(true)
        }
      } catch (error: unknown) {
        if (!cancelled) {
          console.warn('Failed to load local documents', error)
          setReady(true)
        }
      }
    }

    void loadInitialDocs()

    const unsubscribe = subscribeDocs(() => {
      if (!cancelled) {
        void refresh()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [loadDocs, refresh])

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
