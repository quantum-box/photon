/* eslint-disable react-refresh/only-export-components */
import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  redirect,
  useNavigate,
  useMatch,
} from '@tanstack/react-router'
import { useMemo, useCallback, useState, createContext, useContext } from 'react'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { KanbanView } from './components/KanbanView'
import { DetailPanel } from './components/DetailPanel'
import { CreateIssueModal } from './components/CreateIssueModal'
import { ChatView } from './components/chat/ChatView'
import { DocsView } from './components/docs/DocsView'
import { DatabaseRecordsProvider, useDatabaseRecords } from './contexts/IssuesContext'
import { AttachmentsProvider } from './lib/attachments/useWorkspaceAttachments'
import type { Status, DatabaseRecord } from './data/mock'
import type { SortingState } from '@tanstack/react-table'

// ── Search params ──────────────────────────────────────────────

interface IssueSearchParams {
  status?: Status
  sort?: string
  desc?: boolean
}

function validateIssueSearch(search: Record<string, unknown>): IssueSearchParams {
  return {
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
    sort: typeof search.sort === 'string' ? search.sort : undefined,
    desc: search.desc === true || search.desc === 'true' ? true : undefined,
  }
}

// ── Create Issue Modal context ─────────────────────────────────

const CreateModalContext = createContext<{
  open: boolean
  setOpen: (v: boolean) => void
}>({ open: false, setOpen: () => {} })

function useCreateModal() {
  return useContext(CreateModalContext)
}

// ── Root Route ─────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: function RootLayout() {
    const [createModalOpen, setCreateModalOpen] = useState(false)
    return (
      <DatabaseRecordsProvider>
        <AttachmentsProvider>
          <CreateModalContext.Provider value={{ open: createModalOpen, setOpen: setCreateModalOpen }}>
            <div className="flex h-full min-w-0 flex-col overflow-hidden md:flex-row">
              <Sidebar />
              <Outlet />
            </div>
          </CreateModalContext.Provider>
        </AttachmentsProvider>
      </DatabaseRecordsProvider>
    )
  },
})

// ── Index Route (redirect → /databases) ───────────────────────

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/databases' })
  },
})

// ── Databases Layout Route (/databases) ───────────────────────

const databasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'databases',
  validateSearch: validateIssueSearch,
  component: DatabasesLayout,
})

function DatabasesLayout() {
  const { status, sort, desc } = databasesRoute.useSearch()
  const { records, handleUpdateRecord, handleCreateRecord } = useDatabaseRecords()
  const navigate = useNavigate()
  const { open: createModalOpen, setOpen: setCreateModalOpen } = useCreateModal()

  // Get selected issue ID from child detail route
  const detailMatch = useMatch({
    from: issueDetailRoute.id,
    shouldThrow: false,
  })
  const selectedIdentifier = (detailMatch?.params as { recordId?: string })?.recordId ?? null

  const filteredRecords = useMemo(
    () => (status ? records.filter((record) => record.status === status) : records),
    [records, status]
  )

  const selectedRecord = useMemo(
    () =>
      selectedIdentifier
        ? records.find((record) => record.identifier === selectedIdentifier) ?? null
        : null,
    [records, selectedIdentifier]
  )

  // Controlled sorting from URL params
  const sorting: SortingState = useMemo(
    () => (sort ? [{ id: sort, desc: desc ?? false }] : []),
    [sort, desc]
  )

  const handleSortingChange = useCallback(
    (updater: SortingState | ((prev: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === 'function' ? updater(sorting) : updater
      const first = newSorting[0]
      const newSearch: IssueSearchParams = {
        status,
        sort: first?.id,
        desc: first?.desc || undefined,
      }
      if (selectedIdentifier) {
        void navigate({
          to: '/databases/$recordId',
          params: { recordId: selectedIdentifier },
          search: newSearch,
          replace: true,
        })
      } else {
        void navigate({
          to: '/databases',
          search: newSearch,
          replace: true,
        })
      }
    },
    [sorting, navigate, status, selectedIdentifier]
  )

  const handleSelectRecord = useCallback(
    (record: DatabaseRecord) => {
      if (selectedRecord?.id === record.id) {
        void navigate({
          to: '/databases',
          search: { status, sort, desc },
        })
      } else {
        void navigate({
          to: '/databases/$recordId',
          params: { recordId: record.identifier },
          search: { status, sort, desc },
        })
      }
    },
    [navigate, status, sort, desc, selectedRecord]
  )

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
        {/* Header */}
        <div
          className="flex items-center justify-between gap-2 border-b px-3 py-2.5 md:gap-3 md:px-4 md:py-3"
          style={{ borderColor: 'var(--border-color)' }}
        >
          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            <h1 className="text-sm font-semibold">Databases</h1>
            {status && (
              <span
                className="text-xs px-2 py-0.5 rounded-full flex min-w-0 items-center gap-1"
                style={{
                  background: 'var(--bg-hover)',
                  color: 'var(--text-secondary)',
                }}
              >
                {status}
                <button
                  onClick={() =>
                    void navigate({
                      to: '/databases',
                      search: { sort, desc },
                    })
                  }
                  className="ml-1 hover:opacity-75"
                  style={{ color: 'var(--text-muted)' }}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              data-testid="open-create-issue"
              className="px-2.5 py-1.5 md:px-3 rounded text-xs font-medium whitespace-nowrap"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => setCreateModalOpen(true)}
            >
              + New Record
            </button>
          </div>
        </div>

        {/* Table View */}
        <div className="flex-1 min-h-0 mt-1">
          <TableView
            issues={filteredRecords}
            selectedIssueId={selectedRecord?.id ?? null}
            onSelectIssue={handleSelectRecord}
            onUpdateIssue={handleUpdateRecord}
            onCreateIssue={handleCreateRecord}
            sorting={sorting}
            onSortingChange={handleSortingChange}
          />
        </div>
      </div>
      <Outlet />
      <CreateIssueModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateRecord}
      />
    </>
  )
}

// ── Databases Index Route (no detail panel) ───────────────────

const issuesIndexRoute = createRoute({
  getParentRoute: () => databasesRoute,
  path: '/',
  component: () => null,
})

// ── Record Detail Route (/databases/$recordId) ────────────────

const issueDetailRoute = createRoute({
  getParentRoute: () => databasesRoute,
  path: '$recordId',
  component: RecordDetailPanel,
})

function RecordDetailPanel() {
  const { recordId } = issueDetailRoute.useParams()
  const { status, sort, desc } = databasesRoute.useSearch()
  const { records, handleUpdateRecord, handleDeleteRecord } = useDatabaseRecords()
  const navigate = useNavigate()

  const record = useMemo(
    () => records.find((candidate) => candidate.identifier === recordId) ?? null,
    [records, recordId]
  )

  return (
    <DetailPanel
      issue={record}
      onClose={() =>
        void navigate({ to: '/databases', search: { status, sort, desc } })
      }
      onUpdateIssue={handleUpdateRecord}
      onDeleteIssue={handleDeleteRecord}
    />
  )
}

// ── Board Route (/databases/board) ────────────────────────────

const kanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'databases/board',
  validateSearch: (search: Record<string, unknown>): { status?: Status } => ({
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
  }),
  component: KanbanPage,
})

function KanbanPage() {
  const { status } = kanbanRoute.useSearch()
  const { records, handleMoveRecord, handleUpdateRecord, handleDeleteRecord, handleCreateRecord } = useDatabaseRecords()
  const [selectedRecord, setSelectedRecord] = useState<DatabaseRecord | null>(null)
  const navigate = useNavigate()
  const { open: createModalOpen, setOpen: setCreateModalOpen } = useCreateModal()

  const filteredRecords = useMemo(
    () => (status ? records.filter((record) => record.status === status) : records),
    [records, status]
  )

  // Keep the selected record in sync with live data (handles edits & deletes)
  const liveSelectedRecord = useMemo(
    () => (selectedRecord ? records.find((record) => record.id === selectedRecord.id) ?? null : null),
    [records, selectedRecord]
  )

  const handleSelectRecord = useCallback(
    (record: DatabaseRecord) => {
      setSelectedRecord((prev) => (prev?.id === record.id ? null : record))
    },
    []
  )

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
        {/* Header */}
        <div
          className="flex items-center justify-between gap-2 border-b px-3 py-2.5 md:gap-3 md:px-4 md:py-3"
          style={{ borderColor: 'var(--border-color)' }}
        >
          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            <h1 className="text-sm font-semibold">Board</h1>
            {status && (
              <span
                className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1"
                style={{
                  background: 'var(--bg-hover)',
                  color: 'var(--text-secondary)',
                }}
              >
                {status}
                <button
                  onClick={() =>
                    void navigate({ to: '/databases/board', search: {} })
                  }
                  className="ml-1 hover:opacity-75"
                  style={{ color: 'var(--text-muted)' }}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              data-testid="open-create-issue"
              className="px-2.5 py-1.5 md:px-3 rounded text-xs font-medium whitespace-nowrap"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => setCreateModalOpen(true)}
            >
              + New Record
            </button>
          </div>
        </div>

        {/* Kanban View */}
        <div className="flex-1 min-h-0 mt-1">
          <KanbanView
            issues={filteredRecords}
            selectedIssueId={selectedRecord?.id ?? null}
            onSelectIssue={handleSelectRecord}
            onMoveIssue={handleMoveRecord}
          />
        </div>
      </div>
      {liveSelectedRecord && (
        <DetailPanel
          issue={liveSelectedRecord}
          onClose={() => setSelectedRecord(null)}
          onUpdateIssue={handleUpdateRecord}
          onDeleteIssue={(id) => {
            handleDeleteRecord(id)
            setSelectedRecord(null)
          }}
        />
      )}
      <CreateIssueModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateRecord}
      />
    </>
  )
}

// ── Chat Route (/chat) ────────────────────────────────────────

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chat',
  component: ChatPage,
})

function ChatPage() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Chat</h1>
        </div>
      </div>

      {/* Chat View */}
      <div className="flex-1 min-h-0 mt-1">
        <ChatView />
      </div>
    </div>
  )
}

// ── Documents Route (/docs, /documents/$documentId) ───────────

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'docs',
  component: DocsPage,
})

const documentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'documents/$documentId',
  component: DocsPage,
})

// ── Legacy Route Redirects ────────────────────────────────────

const legacyIssuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'issues',
  beforeLoad: () => {
    throw redirect({ to: '/databases' })
  },
})

const legacyIssueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'issues/$issueId',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/databases/$recordId',
      params: { recordId: params.issueId },
    })
  },
})

const legacyKanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'kanban',
  beforeLoad: () => {
    throw redirect({ to: '/databases/board' })
  },
})

function DocsPage() {
  const detailMatch = useMatch({
    from: documentDetailRoute.id,
    shouldThrow: false,
  })
  const selectedDocId = (detailMatch?.params as { documentId?: string })?.documentId ?? null

  return <DocsView selectedDocId={selectedDocId} />
}

// ── Route Tree & Router ───────────────────────────────────────

const routeTree = rootRoute.addChildren([
  indexRoute,
  databasesRoute.addChildren([issuesIndexRoute, issueDetailRoute]),
  kanbanRoute,
  legacyIssuesRoute,
  legacyIssueDetailRoute,
  legacyKanbanRoute,
  chatRoute,
  docsRoute,
  documentDetailRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
