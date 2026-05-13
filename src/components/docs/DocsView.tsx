import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import '@blocknote/core/fonts/inter.css'
import { appKitConfig } from '../../app/kitConfig'
import type { DocumentCollaboration } from '../../lib/docs/docYjs'
import { useDocumentCollaboration } from '../../lib/docs/useDocumentCollaboration'
import { useDocs } from '../../lib/docs/useDocs'
import type { DocMetadata } from '../../lib/docs/types'

interface DocsViewProps {
  selectedDocId: string | null
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

const syncStatusLabels = {
  connecting: 'Server connecting',
  connected: 'Server connected',
  offline: 'Local only',
} as const

const syncStatusColors = {
  connecting: '#f5a623',
  connected: '#34c759',
  offline: '#ff3b30',
} as const

function DocsList({
  docs,
  selectedDocId,
  onCreate,
}: {
  docs: DocMetadata[]
  selectedDocId: string | null
  onCreate: () => void
}) {
  return (
    <div className="flex min-h-0 w-full shrink-0 flex-col border-b border-border bg-panel md:w-72 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 md:px-4 md:py-3">
        <div>
          <h1 className="text-sm font-semibold">Docs</h1>
          <p className="text-xs text-subtle">{docs.length} local docs</p>
        </div>
        <button
          data-testid="create-doc"
          className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-white"
          onClick={onCreate}
        >
          + New
        </button>
      </div>

      <div className="flex gap-1 overflow-x-auto p-2 md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto">
        {docs.map((doc) => (
          <Link
            key={doc.id}
            to="/documents/$documentId"
            params={{ documentId: doc.id }}
            className={`block min-w-56 rounded px-3 py-2 no-underline transition-colors md:min-w-0 ${
              selectedDocId === doc.id
                ? 'bg-surface-hover text-foreground'
                : 'text-muted hover:bg-surface-hover'
            }`}
          >
            <div className="truncate text-sm font-medium">{doc.title}</div>
            <div className="mt-1 text-xs text-subtle">{formatDate(doc.updatedAt)}</div>
          </Link>
        ))}
        {docs.length === 0 && (
          <div className="px-3 py-8 text-sm text-subtle">
            No docs yet.
          </div>
        )}
      </div>
    </div>
  )
}

function BlockNoteDocumentEditor({
  collab,
}: {
  collab: DocumentCollaboration
}) {
  const editor = useCreateBlockNote(
    {
      collaboration: {
        fragment: collab.fragment,
        user: {
          name: 'Photon user',
          color: '#5b5bf7',
        },
        showCursorLabels: 'activity',
      },
    },
    [collab.roomId]
  )

  return (
    <BlockNoteView
      editor={editor}
      className="photon-blocknote"
      data-theming-css-variables-demo
    />
  )
}

function DocumentEditor({
  doc,
  onRename,
}: {
  doc: DocMetadata
  onRename: (title: string) => void
}) {
  const { collab, ready, syncStatus, roomId } = useDocumentCollaboration(doc.id)
  const [title, setTitle] = useState(doc.title)

  useEffect(() => {
    setTitle(doc.title)
  }, [doc.id, doc.title])

  useEffect(() => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || trimmedTitle === doc.title) return

    const timer = setTimeout(() => {
      onRename(trimmedTitle)
    }, 500)

    return () => clearTimeout(timer)
  }, [doc.title, onRename, title])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <input
          aria-label="Document title"
          className="w-full bg-transparent text-xl font-semibold outline-none"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => onRename(title)}
        />
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: syncStatusColors[syncStatus] }}
            />
            {syncStatusLabels[syncStatus]}
          </span>
          <span>·</span>
          <span>PGlite metadata</span>
          <span>·</span>
          <span>Yjs blocks</span>
          <span>·</span>
          <span>{formatDate(doc.updatedAt)}</span>
          {roomId && (
            <>
              <span>·</span>
              <span className="max-w-full truncate">{roomId}</span>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-8">
        <div className="mx-auto max-w-3xl">
          {!ready || !collab ? (
            <div className="shimmer rounded bg-surface px-3 py-2 text-sm text-subtle">
              Loading document...
            </div>
          ) : (
            <BlockNoteDocumentEditor collab={collab} />
          )}
        </div>
      </div>
    </div>
  )
}

export function DocsView({ selectedDocId }: DocsViewProps) {
  const { docs, ready, createDocument, ensureDocument, renameDocument } = useDocs()
  const navigate = useNavigate()
  const selectedDoc = useMemo(
    () => {
      const existingDoc = docs.find((doc) => doc.id === selectedDocId)
      if (existingDoc || !selectedDocId) return existingDoc ?? null

      const now = new Date().toISOString()
      return {
        id: selectedDocId,
        title: 'Shared document',
        workspaceId: appKitConfig.workspace.id,
        createdAt: now,
        updatedAt: now,
      }
    },
    [docs, selectedDocId]
  )

  useEffect(() => {
    if (!ready || selectedDocId || docs.length === 0) return
    void navigate({
      to: '/documents/$documentId',
      params: { documentId: docs[0].id },
      replace: true,
    })
  }, [docs, navigate, ready, selectedDocId])

  useEffect(() => {
    if (!ready || !selectedDocId || selectedDoc) return
    void ensureDocument(selectedDocId)
  }, [ensureDocument, ready, selectedDoc, selectedDocId])

  const handleCreate = async () => {
    const doc = await createDocument()
    void navigate({ to: '/documents/$documentId', params: { documentId: doc.id } })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:flex-row md:p-2">
      <DocsList docs={docs} selectedDocId={selectedDocId} onCreate={handleCreate} />

      <div className="mt-1 flex min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas md:mt-0">
        {selectedDoc ? (
          <DocumentEditor
            doc={selectedDoc}
            onRename={(title) => {
              void renameDocument(selectedDoc.id, title)
            }}
          />
        ) : !ready ? (
          <div className="flex flex-1 items-center justify-center text-sm text-subtle">
            Loading docs...
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="max-w-sm text-center">
              <div className="text-sm font-semibold">Start a workspace doc</div>
              <p className="mt-2 text-sm leading-6 text-muted">
                Local metadata is stored in PGlite, while document blocks are kept in a Yjs document for collaboration-ready editing.
              </p>
              <button
                className="mt-4 rounded bg-accent px-3 py-2 text-sm font-medium text-white"
                onClick={handleCreate}
              >
                Create doc
              </button>
              <div className="mt-3 text-xs text-subtle">
                {appKitConfig.docs.pgliteDataDir}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
