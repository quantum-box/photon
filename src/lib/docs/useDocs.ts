import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocMetadata } from './types'
import {
  cacheDocMetadata,
  createDoc,
  ensureDoc,
  getDoc,
  listDocs,
  subscribeDocs,
  updateDoc,
} from './docsDb'
import {
  createServerDocument,
  DocsApiError,
  fetchServerDocument,
  fetchServerDocuments,
  updateServerDocument,
} from './docsApi'

const sharedDocumentTitle = 'Shared document'

export function useDocs() {
  const [docs, setDocs] = useState<DocMetadata[]>([])
  const [ready, setReady] = useState(false)

  const loadDocs = useCallback(async () => {
    try {
      const serverDocs = await fetchServerDocuments()
      await Promise.all(
        serverDocs.map((doc) => cacheDocMetadata(doc, { emit: false }))
      )
      return serverDocs
    } catch (error: unknown) {
      console.warn('Failed to load server documents; using local cache', error)
      return listDocs()
    }
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
    try {
      const serverDoc = await createServerDocument({ title })
      await cacheDocMetadata(serverDoc)
      return serverDoc
    } catch (error: unknown) {
      console.warn('Failed to create server document; keeping local metadata', error)
      return createDoc({ title })
    }
  }, [])

  const ensureDocument = useCallback(async (docId: string) => {
    const cachedDoc = await getDoc(docId)
    if (cachedDoc) return cachedDoc

    try {
      const serverDoc = await fetchServerDocument(docId)
      await cacheDocMetadata(serverDoc)
      return serverDoc
    } catch (error: unknown) {
      if (!(error instanceof DocsApiError && error.status === 404)) {
        console.warn('Failed to fetch server document; ensuring local metadata', error)
        return ensureDoc(docId)
      }
    }

    try {
      const serverDoc = await createServerDocument({
        id: docId,
        title: sharedDocumentTitle,
      })
      await cacheDocMetadata(serverDoc)
      return serverDoc
    } catch (error: unknown) {
      console.warn('Failed to create server document; ensuring local metadata', error)
      return ensureDoc(docId)
    }
  }, [])

  const renameDocument = useCallback(async (docId: string, title: string) => {
    try {
      const serverDoc = await updateServerDocument(docId, { title })
      await cacheDocMetadata(serverDoc)
      return serverDoc
    } catch (error: unknown) {
      console.warn('Failed to rename server document; updating local metadata', error)
      return updateDoc(docId, { title })
    }
  }, [])

  return useMemo(
    () => ({ docs, ready, refresh, createDocument, ensureDocument, renameDocument }),
    [docs, ready, refresh, createDocument, ensureDocument, renameDocument]
  )
}
