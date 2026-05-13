/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import * as Y from 'yjs'
import { ydoc, attachmentsArray, initialSyncReady } from '../yjs/yjsProvider'
import {
  createServerAttachment,
  deleteServerAttachment,
  fetchServerAttachments,
  linkServerAttachment,
} from './attachmentsApi'
import type {
  AttachmentSurfaceRef,
  CreateWorkspaceAttachmentInput,
  WorkspaceAttachment,
} from './types'

const runtimeFiles = new Map<string, { file: File; objectUrl: string }>()

interface AttachmentsContextValue {
  attachments: WorkspaceAttachment[]
  ready: boolean
  createAttachment: (input: CreateWorkspaceAttachmentInput) => Promise<WorkspaceAttachment>
  linkAttachment: (attachmentId: string, surface: AttachmentSurfaceRef) => Promise<WorkspaceAttachment | null>
  deleteAttachment: (attachmentId: string) => Promise<void>
  attachmentsForSurface: (surface: AttachmentSurfaceRef) => WorkspaceAttachment[]
}

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null)

function ymapToAttachment(ymap: Y.Map<string>): WorkspaceAttachment {
  const rawLinks = ymap.get('links') as string | undefined
  const rawPreviewMetadata = ymap.get('previewMetadata') as string | undefined
  const id = (ymap.get('id') as string) ?? ''
  const runtime = runtimeFiles.get(id)

  return {
    id,
    workspaceId: (ymap.get('workspaceId') as string) ?? '',
    filename: (ymap.get('filename') as string) ?? '',
    contentType: (ymap.get('contentType') as string) ?? 'application/octet-stream',
    byteSize: Number(ymap.get('byteSize') ?? 0),
    storageProvider: ((ymap.get('storageProvider') as string) ?? 'web-object-storage') as WorkspaceAttachment['storageProvider'],
    storageKey: (ymap.get('storageKey') as string) ?? '',
    contentStatus: ((ymap.get('contentStatus') as string) ?? 'local_cache') as WorkspaceAttachment['contentStatus'],
    previewMetadata: rawPreviewMetadata
      ? JSON.parse(rawPreviewMetadata) as WorkspaceAttachment['previewMetadata']
      : { fileType: 'unknown', previewStatus: 'metadata_only' },
    createdBy: (ymap.get('createdBy') as string) || null,
    createdAt: (ymap.get('createdAt') as string) ?? '',
    updatedAt: (ymap.get('updatedAt') as string) ?? '',
    links: rawLinks ? JSON.parse(rawLinks) as WorkspaceAttachment['links'] : [],
    file: runtime?.file,
    objectUrl: runtime?.objectUrl,
  }
}

function writeAttachmentToYMap(ymap: Y.Map<string>, attachment: WorkspaceAttachment) {
  ymap.set('id', attachment.id)
  ymap.set('workspaceId', attachment.workspaceId)
  ymap.set('filename', attachment.filename)
  ymap.set('contentType', attachment.contentType)
  ymap.set('byteSize', String(attachment.byteSize))
  ymap.set('storageProvider', attachment.storageProvider)
  ymap.set('storageKey', attachment.storageKey)
  ymap.set('contentStatus', attachment.contentStatus)
  ymap.set('previewMetadata', JSON.stringify(attachment.previewMetadata))
  ymap.set('createdBy', attachment.createdBy ?? '')
  ymap.set('createdAt', attachment.createdAt)
  ymap.set('updatedAt', attachment.updatedAt)
  ymap.set('links', JSON.stringify(attachment.links))
}

function findYAttachment(id: string): Y.Map<string> | null {
  for (let i = 0; i < attachmentsArray.length; i++) {
    const ymap = attachmentsArray.get(i)
    if (ymap.get('id') === id) return ymap
  }
  return null
}

function upsertYAttachment(attachment: WorkspaceAttachment) {
  const existing = findYAttachment(attachment.id)
  if (existing) {
    writeAttachmentToYMap(existing, attachment)
    return
  }
  const ymap = new Y.Map<string>()
  writeAttachmentToYMap(ymap, attachment)
  attachmentsArray.push([ymap])
}

function removeYAttachment(attachmentId: string) {
  for (let i = 0; i < attachmentsArray.length; i++) {
    if (attachmentsArray.get(i).get('id') === attachmentId) {
      attachmentsArray.delete(i, 1)
      return
    }
  }
}

function snapshot(): WorkspaceAttachment[] {
  const result: WorkspaceAttachment[] = []
  attachmentsArray.forEach((ymap) => {
    result.push(ymapToAttachment(ymap))
  })
  return result
}

export function AttachmentsProvider({ children }: { children: ReactNode }) {
  const [attachments, setAttachments] = useState<WorkspaceAttachment[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let rafId: number | null = null
    let observing = false
    let unmounted = false

    function debouncedSnapshot() {
      if (unmounted) return
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!unmounted) setAttachments(snapshot())
      })
    }

    initialSyncReady.then(() => {
      if (unmounted) return
      setAttachments(snapshot())
      setReady(true)
      attachmentsArray.observeDeep(debouncedSnapshot)
      observing = true
    })

    return () => {
      unmounted = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (observing) attachmentsArray.unobserveDeep(debouncedSnapshot)
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    fetchServerAttachments()
      .then((serverAttachments) => {
        if (cancelled) return
        ydoc.transact(() => {
          for (const attachment of serverAttachments) {
            upsertYAttachment(attachment)
          }
        })
      })
      .catch((error: unknown) => {
        console.warn('Failed to hydrate attachment metadata from the application server', error)
      })
    return () => {
      cancelled = true
    }
  }, [ready])

  const createAttachment = useCallback(async (input: CreateWorkspaceAttachmentInput) => {
    const objectUrl = URL.createObjectURL(input.file)
    const attachment = await createServerAttachment(input)
    runtimeFiles.set(attachment.id, { file: input.file, objectUrl })
    const withRuntime = { ...attachment, file: input.file, objectUrl }
    ydoc.transact(() => upsertYAttachment(withRuntime))
    return withRuntime
  }, [])

  const linkAttachment = useCallback(async (attachmentId: string, surface: AttachmentSurfaceRef) => {
    const attachment = await linkServerAttachment(attachmentId, surface)
    const runtime = runtimeFiles.get(attachment.id)
    const withRuntime = { ...attachment, file: runtime?.file, objectUrl: runtime?.objectUrl }
    ydoc.transact(() => upsertYAttachment(withRuntime))
    return withRuntime
  }, [])

  const deleteAttachment = useCallback(async (attachmentId: string) => {
    await deleteServerAttachment(attachmentId)
    const runtime = runtimeFiles.get(attachmentId)
    if (runtime) {
      URL.revokeObjectURL(runtime.objectUrl)
      runtimeFiles.delete(attachmentId)
    }
    ydoc.transact(() => removeYAttachment(attachmentId))
  }, [])

  const attachmentsForSurface = useCallback(
    (surface: AttachmentSurfaceRef) =>
      attachments.filter((attachment) =>
        attachment.links.some((link) =>
          link.surfaceType === surface.surfaceType && link.surfaceId === surface.surfaceId
        )
      ),
    [attachments]
  )

  const value = useMemo(
    () => ({
      attachments,
      ready,
      createAttachment,
      linkAttachment,
      deleteAttachment,
      attachmentsForSurface,
    }),
    [attachments, attachmentsForSurface, createAttachment, deleteAttachment, linkAttachment, ready]
  )

  return <AttachmentsContext.Provider value={value}>{children}</AttachmentsContext.Provider>
}

export function useWorkspaceAttachments() {
  const ctx = useContext(AttachmentsContext)
  if (!ctx) throw new Error('useWorkspaceAttachments must be used within AttachmentsProvider')
  return ctx
}
