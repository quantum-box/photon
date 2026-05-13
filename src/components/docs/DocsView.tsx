import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { appKitConfig } from '../../app/kitConfig'
import { blockTypes } from '../../lib/docs/docYjs'
import { useDocumentBlocks } from '../../lib/docs/useDocumentBlocks'
import { useDocs } from '../../lib/docs/useDocs'
import type { DocBlock, DocBlockType, DocMetadata } from '../../lib/docs/types'

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

function blockPlaceholder(type: DocBlockType) {
  switch (type) {
    case 'heading':
      return 'Heading'
    case 'checklist':
      return 'Task'
    case 'code':
      return 'Code'
    case 'quote':
      return 'Quote'
    case 'table':
      return 'Table notes'
    default:
      return 'Write something'
  }
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

function BlockEditor({
  block,
  onUpdate,
  onAddAfter,
  onDelete,
}: {
  block: DocBlock
  onUpdate: (patch: Partial<Omit<DocBlock, 'id'>>) => void
  onAddAfter: (type?: DocBlockType) => void
  onDelete: () => void
}) {
  const isDivider = block.type === 'divider'
  const isTable = block.type === 'table'

  return (
    <div className="group flex gap-2 rounded px-2 py-1.5 hover:bg-surface-hover">
      <div className="mt-1.5 flex w-24 shrink-0 items-start gap-1 opacity-70 group-hover:opacity-100">
        <select
          aria-label="Block type"
          className="w-20 rounded border border-border bg-surface px-1 py-1 text-[11px] text-muted outline-none"
          value={block.type}
          onChange={(event) => onUpdate({ type: event.target.value as DocBlockType })}
        >
          {blockTypes.map((option) => (
            <option key={option.type} value={option.type}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className="rounded px-1 text-xs text-subtle hover:bg-panel hover:text-foreground"
          title="Add block"
          onClick={() => onAddAfter()}
        >
          +
        </button>
      </div>

      <div className="min-w-0 flex-1">
        {isDivider ? (
          <div className="py-4">
            <div className="h-px bg-border" />
          </div>
        ) : isTable ? (
          <div className="rounded border border-dashed border-border bg-surface px-3 py-2 text-sm text-muted">
            Table placeholder
            <textarea
              className="doc-block-textarea mt-2 min-h-16 w-full resize-none bg-transparent text-sm text-foreground outline-none"
              value={block.text}
              placeholder={blockPlaceholder(block.type)}
              onChange={(event) => onUpdate({ text: event.target.value })}
            />
          </div>
        ) : (
          <div className="flex min-w-0 items-start gap-2">
            {block.type === 'checklist' && (
              <input
                aria-label="Checklist done"
                className="mt-2"
                type="checkbox"
                checked={block.checked}
                onChange={(event) => onUpdate({ checked: event.target.checked })}
              />
            )}
            <textarea
              className={`doc-block-textarea min-h-8 w-full resize-none bg-transparent outline-none ${
                block.type === 'heading'
                  ? 'text-2xl font-semibold leading-snug'
                  : block.type === 'code'
                    ? 'rounded bg-code px-3 py-2 font-mono text-sm text-code-text'
                    : block.type === 'quote'
                      ? 'border-l-2 border-accent pl-3 text-sm italic text-muted'
                      : 'text-sm leading-6 text-foreground'
              }`}
              value={block.text}
              placeholder={blockPlaceholder(block.type)}
              rows={block.type === 'code' ? 4 : 1}
              onChange={(event) => onUpdate({ text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && block.type !== 'code') {
                  event.preventDefault()
                  onAddAfter()
                }
              }}
            />
          </div>
        )}
      </div>

      <button
        className="mt-1 h-6 rounded px-1.5 text-xs text-subtle opacity-0 hover:bg-panel hover:text-foreground group-hover:opacity-100"
        title="Delete block"
        onClick={onDelete}
      >
        ×
      </button>
    </div>
  )
}

function DocumentEditor({
  doc,
  onRename,
}: {
  doc: DocMetadata
  onRename: (title: string) => void
}) {
  const { blocks, ready, syncStatus, roomId, updateBlock, addBlockAfter, deleteBlock } = useDocumentBlocks(doc.id)
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
          {!ready ? (
            <div className="shimmer rounded bg-surface px-3 py-2 text-sm text-subtle">
              Loading document...
            </div>
          ) : (
            <div className="space-y-1">
              <div className="sticky top-0 z-10 mb-3 flex gap-1 overflow-x-auto border-b border-border bg-canvas/95 px-2 pb-3 pt-1 backdrop-blur">
                {blockTypes.map((option) => (
                  <button
                    key={option.type}
                    className="shrink-0 rounded border border-border bg-surface px-2 py-1 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
                    onClick={() => addBlockAfter(blocks.at(-1)?.id ?? null, option.type)}
                  >
                    + {option.label}
                  </button>
                ))}
              </div>
              {blocks.map((block) => (
                <BlockEditor
                  key={block.id}
                  block={block}
                  onUpdate={(patch) => updateBlock(block.id, patch)}
                  onAddAfter={(type) => addBlockAfter(block.id, type)}
                  onDelete={() => deleteBlock(block.id)}
                />
              ))}
              <button
                className="ml-[6.5rem] mt-2 rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
                onClick={() => addBlockAfter(blocks.at(-1)?.id ?? null)}
              >
                + Add block
              </button>
            </div>
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
