import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCreateBlockNote, useEditorSelectionChange } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'
import { appKitConfig } from '../../app/kitConfig'
import { useIssues } from '../../contexts/IssuesContext'
import { createServerIssue } from '../../lib/issuesApi'
import type { DocumentCollaboration } from '../../lib/docs/docYjs'
import { useDocumentCollaboration } from '../../lib/docs/useDocumentCollaboration'
import { useDocs } from '../../lib/docs/useDocs'
import {
  linkDocIssue,
  listDocIssueLinks,
} from '../../lib/docs/docsDb'
import {
  setCurrentDocContext,
  setCurrentDocSelectedText,
} from '../../lib/docs/workspaceContext'
import type { DocMetadata, DocumentIssueLink } from '../../lib/docs/types'
import type { Issue } from '../../data/mock'

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
  linkedIssue,
  selectedText,
  onSelectedTextChange,
}: {
  collab: DocumentCollaboration
  linkedIssue: Issue | null
  selectedText: string
  onSelectedTextChange: (text: string) => void
}) {
  const editor = useCreateBlockNote(
    {
      collaboration: {
        provider: collab.provider,
        fragment: collab.fragment,
        user: collab.user,
        showCursorLabels: 'activity',
      },
    },
    [collab.roomId]
  )

  useEditorSelectionChange(() => {
    onSelectedTextChange(editor.getSelectedText().trim())
  }, editor)

  useEffect(() => {
    if (!linkedIssue) return
    const currentBlock = editor.getTextCursorPosition().block
    const blocks = editor.tryParseMarkdownToBlocks(
      `Linked issue: [${linkedIssue.identifier} ${linkedIssue.title}](/issues/${linkedIssue.identifier})`
    )
    editor.insertBlocks(blocks, currentBlock, 'after')
  }, [editor, linkedIssue])

  return (
    <div>
      {selectedText && (
        <div
          data-testid="doc-selected-text"
          className="mb-3 rounded border border-border bg-surface px-3 py-2 text-xs text-muted"
        >
          Selected: <span className="text-foreground">{selectedText}</span>
        </div>
      )}
      <BlockNoteView
        editor={editor}
        className="photon-blocknote"
        data-theming-css-variables-demo
      />
    </div>
  )
}

function DocumentTitleInput({
  doc,
  onRename,
}: {
  doc: DocMetadata
  onRename: (title: string) => void
}) {
  const [title, setTitle] = useState(doc.title)

  useEffect(() => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || trimmedTitle === doc.title) return

    const timer = setTimeout(() => {
      onRename(trimmedTitle)
    }, 500)

    return () => clearTimeout(timer)
  }, [doc.title, onRename, title])

  return (
    <input
      aria-label="Document title"
      className="w-full bg-transparent text-xl font-semibold outline-none"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={() => onRename(title)}
    />
  )
}

function DocumentEditor({
  doc,
  issues,
  links,
  onIssueLinked,
  onCreateIssueFromSelection,
  onRename,
}: {
  doc: DocMetadata
  issues: Issue[]
  links: DocumentIssueLink[]
  onIssueLinked: (issue: Issue, selectedText: string) => Promise<void>
  onCreateIssueFromSelection: (selectedText: string) => Promise<Issue | null>
  onRename: (title: string) => void
}) {
  const { collab, ready, syncStatus, roomId } = useDocumentCollaboration(doc.id)
  const [selectedText, setSelectedText] = useState('')
  const [selectedIssueId, setSelectedIssueId] = useState('')
  const [insertedIssue, setInsertedIssue] = useState<Issue | null>(null)

  useEffect(() => {
    setCurrentDocContext(doc.id, doc.title, `/documents/${doc.id}`)
  }, [doc.id, doc.title])

  const handleSelectedTextChange = useCallback((text: string) => {
    if (!text) return
    setSelectedText(text)
    setCurrentDocSelectedText(doc.id, text)
  }, [doc.id])

  const handleLinkSelectedIssue = async () => {
    const issue = issues.find((candidate) => candidate.id === selectedIssueId)
    if (!issue) return
    await onIssueLinked(issue, selectedText)
    setInsertedIssue(issue)
    setSelectedIssueId('')
  }

  const handleCreateFromSelection = async () => {
    const issue = await onCreateIssueFromSelection(selectedText)
    if (issue) setInsertedIssue(issue)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <DocumentTitleInput key={doc.id} doc={doc} onRename={onRename} />
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            data-testid="doc-link-issue-select"
            aria-label="Link issue to document"
            className="max-w-xs rounded border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
            value={selectedIssueId}
            onChange={(event) => setSelectedIssueId(event.target.value)}
          >
            <option value="">Link issue...</option>
            {issues.slice(0, 100).map((issue) => (
              <option key={issue.id} value={issue.id}>
                {issue.identifier} {issue.title}
              </option>
            ))}
          </select>
          <button
            data-testid="doc-link-issue"
            className="rounded bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
            disabled={!selectedIssueId}
            onClick={() => void handleLinkSelectedIssue()}
          >
            Link
          </button>
          <button
            data-testid="doc-create-issue-from-selection"
            className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            disabled={!selectedText}
            onClick={() => void handleCreateFromSelection()}
          >
            Create issue from selection
          </button>
        </div>
        {links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="doc-related-issues">
            {links.map((link) => (
              <Link
                key={link.id}
                to="/issues/$issueId"
                params={{ issueId: link.issueIdentifier }}
                className="rounded bg-surface-hover px-2 py-1 text-xs text-muted no-underline hover:text-foreground"
              >
                {link.issueIdentifier}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-8">
        <div className="mx-auto max-w-3xl">
          {!ready || !collab ? (
            <div className="shimmer rounded bg-surface px-3 py-2 text-sm text-subtle">
              Loading document...
            </div>
          ) : (
            <BlockNoteDocumentEditor
              collab={collab}
              linkedIssue={insertedIssue}
              selectedText={selectedText}
              onSelectedTextChange={handleSelectedTextChange}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export function DocsView({ selectedDocId }: DocsViewProps) {
  const { docs, ready, createDocument, ensureDocument, renameDocument } = useDocs()
  const { issues, syncIssue } = useIssues()
  const navigate = useNavigate()
  const [linksByDocId, setLinksByDocId] = useState<Record<string, DocumentIssueLink[]>>({})
  const selectedDoc = useMemo(
    () => {
      const existingDoc = docs.find((doc) => doc.id === selectedDocId)
      return existingDoc ?? null
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

  useEffect(() => {
    if (!selectedDoc) return
    let cancelled = false
    void listDocIssueLinks(selectedDoc.id).then((links) => {
      if (!cancelled) {
        setLinksByDocId((prev) => ({ ...prev, [selectedDoc.id]: links }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedDoc])

  const handleCreate = async () => {
    const doc = await createDocument()
    void navigate({ to: '/documents/$documentId', params: { documentId: doc.id } })
  }

  const handleIssueLinked = useCallback(async (issue: Issue, selectedText: string) => {
    if (!selectedDoc) return
    const link = await linkDocIssue({
      docId: selectedDoc.id,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      selectedText,
    })
    setLinksByDocId((prev) => ({
      ...prev,
      [selectedDoc.id]: [link, ...(prev[selectedDoc.id] ?? []).filter((item) => item.id !== link.id)],
    }))
  }, [selectedDoc])

  const handleCreateIssueFromSelection = useCallback(async (selectedText: string) => {
    if (!selectedDoc || !selectedText.trim()) return null
    const issue = await createServerIssue({
      title: selectedText.trim().slice(0, 120),
      description: `Created from document "${selectedDoc.title}".\n\n> ${selectedText.trim()}`,
      status: 'todo',
      priority: 'none',
      labels: ['docs'],
    })
    syncIssue(issue)
    await handleIssueLinked(issue, selectedText)
    return issue
  }, [handleIssueLinked, selectedDoc, syncIssue])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:flex-row md:p-2">
      <DocsList docs={docs} selectedDocId={selectedDocId} onCreate={handleCreate} />

      <div className="mt-1 flex min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas md:mt-0">
        {selectedDoc ? (
          <DocumentEditor
            key={selectedDoc.id}
            doc={selectedDoc}
            issues={issues}
            links={linksByDocId[selectedDoc.id] ?? []}
            onIssueLinked={handleIssueLinked}
            onCreateIssueFromSelection={handleCreateIssueFromSelection}
            onRename={(title) => {
              void renameDocument(selectedDoc.id, title)
            }}
          />
        ) : !ready ? (
          <div className="flex flex-1 items-center justify-center text-sm text-subtle">
            Loading docs...
          </div>
        ) : selectedDocId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-subtle">
            Loading document...
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
