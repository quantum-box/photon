/* eslint-disable react-refresh/only-export-components */
import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  redirect,
  useNavigate,
  useMatch,
  Link,
} from '@tanstack/react-router'
import { useMemo, useCallback, useState, createContext, useContext } from 'react'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { KanbanView } from './components/KanbanView'
import { WorkflowView } from './components/WorkflowView'
import { DetailPanel } from './components/DetailPanel'
import { CreateIssueModal } from './components/CreateIssueModal'
import { ChatView } from './components/chat/ChatView'
import { DocsView } from './components/docs/DocsView'
import { DatabaseRecordsProvider, useDatabaseRecords } from './contexts/IssuesContext'
import { DatabasesProvider, type WorkspaceDatabase, useWorkspaceDatabases } from './contexts/DatabasesContext'
import { AttachmentsProvider } from './lib/attachments/useWorkspaceAttachments'
import { statusConfig, type Status, type DatabaseRecord } from './data/mock'
import type { SortingState } from '@tanstack/react-table'

// ── Search params ──────────────────────────────────────────────

interface IssueSearchParams {
  database?: string
  status?: Status
  sort?: string
  desc?: boolean
}

function validateIssueSearch(search: Record<string, unknown>): IssueSearchParams {
  return {
    database: typeof search.database === 'string' ? search.database : undefined,
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
    sort: typeof search.sort === 'string' ? search.sort : undefined,
    desc: search.desc === true || search.desc === 'true' ? true : undefined,
  }
}

function getDatabaseProject(databases: WorkspaceDatabase[], databaseId: string | undefined) {
  return databases.find((project) => project.id === databaseId) ?? null
}

function filterRecordsByDatabase(
  records: DatabaseRecord[],
  databases: WorkspaceDatabase[],
  databaseId: string | undefined
) {
  const database = getDatabaseProject(databases, databaseId)
  return database ? records.filter((record) => record.project === database.label) : records
}

// ── Create Issue Modal context ─────────────────────────────────

const CreateModalContext = createContext<{
  open: boolean
  setOpen: (v: boolean) => void
}>({ open: false, setOpen: () => {} })

function useCreateModal() {
  return useContext(CreateModalContext)
}

function DatabaseHeader({
  title,
  databaseLabel,
  currentView,
  database,
  status,
  onClearStatus,
  onCreate,
  onToggleFilters,
  filtersOpen,
}: {
  title: string
  databaseLabel: string
  currentView: 'table' | 'kanban' | 'workflow'
  database?: string
  status?: Status
  onClearStatus?: () => void
  onCreate?: () => void
  onToggleFilters?: () => void
  filtersOpen?: boolean
}) {
  const viewLinks = [
    { id: 'table' as const, label: 'Table', to: '/databases' as const },
    { id: 'kanban' as const, label: 'Board', to: '/databases/board' as const },
    { id: 'workflow' as const, label: 'Workflow', to: '/databases/workflow' as const },
  ]

  return (
    <div
      className="flex flex-col gap-2 border-b px-3 py-2.5 md:px-4 md:py-3"
      style={{ borderColor: 'var(--border-color)' }}
    >
      <div className="flex items-center justify-between gap-2 md:gap-3">
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <h1 className="text-sm font-semibold">{title}</h1>
          <span
            data-testid="selected-database-pill"
            className="truncate rounded-full bg-surface-hover px-2 py-0.5 text-xs text-muted"
          >
            {databaseLabel}
          </span>
          {status && (
            <span
              data-testid="status-filter-pill"
              className="flex min-w-0 items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-xs text-muted"
            >
              {statusConfig[status].label}
              {onClearStatus && (
                <button
                  onClick={onClearStatus}
                  className="ml-1 hover:opacity-75"
                  style={{ color: 'var(--text-muted)' }}
                >
                  x
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onToggleFilters && (
            <button
              data-testid="toggle-database-filters"
              className="rounded bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
              onClick={onToggleFilters}
            >
              {filtersOpen ? 'Hide Filters' : 'Filters'}
            </button>
          )}
          {onCreate && (
            <button
              data-testid="open-create-issue"
              className="whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium md:px-3"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={onCreate}
            >
              + New Record
            </button>
          )}
        </div>
      </div>
      <nav className="flex w-full gap-1 overflow-x-auto" aria-label="Database views">
        {viewLinks.map((view) => (
          <Link
            key={view.id}
            data-testid={`view-${view.id}`}
            to={view.to}
            search={
              view.id === 'workflow'
                ? { database }
                : { database, ...(status ? { status } : {}) }
            }
            className={`min-w-20 rounded px-3 py-1.5 text-center text-xs font-medium no-underline transition-colors ${
              currentView === view.id
                ? 'bg-accent text-white'
                : 'bg-surface-hover text-muted hover:text-foreground'
            }`}
          >
            {view.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}

function DatabaseStatusPanel({
  open,
  records,
  status,
  onStatusChange,
}: {
  open: boolean
  records: DatabaseRecord[]
  status?: Status
  onStatusChange: (status: Status | undefined) => void
}) {
  const recordCountByStatus = useMemo(
    () =>
      records.reduce(
        (acc, record) => {
          acc[record.status] = (acc[record.status] || 0) + 1
          return acc
        },
        {} as Record<Status, number>
      ),
    [records]
  )

  if (!open) return null

  return (
    <aside
      data-testid="database-filter-panel"
      className="hidden w-64 shrink-0 border-l border-border bg-panel p-3 md:flex md:flex-col"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-subtle">
          Database Filters
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <button
          className={`flex items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
            !status
              ? 'bg-surface-hover text-foreground'
              : 'text-muted hover:bg-surface-hover'
          }`}
          onClick={() => onStatusChange(undefined)}
        >
          <span>All records</span>
          <span className="text-xs text-subtle">{records.length}</span>
        </button>
        {(Object.entries(statusConfig) as [Status, (typeof statusConfig)[Status]][]).map(
          ([key, config]) => (
            <button
              key={key}
              className={`flex items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
                status === key
                  ? 'bg-surface-hover text-foreground'
                  : 'text-muted hover:bg-surface-hover'
              }`}
              onClick={() => onStatusChange(status === key ? undefined : key)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span style={{ color: config.color }}>{config.icon}</span>
                <span className="truncate">{config.label}</span>
              </span>
              <span className="text-xs text-subtle">{recordCountByStatus[key] || 0}</span>
            </button>
          )
        )}
      </div>
    </aside>
  )
}

// ── Root Route ─────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: function RootLayout() {
    const [createModalOpen, setCreateModalOpen] = useState(false)
    return (
      <DatabaseRecordsProvider>
        <DatabasesProvider>
          <AttachmentsProvider>
            <CreateModalContext.Provider value={{ open: createModalOpen, setOpen: setCreateModalOpen }}>
              <div className="flex h-full min-w-0 flex-col overflow-hidden md:flex-row">
                <Sidebar />
                <Outlet />
              </div>
            </CreateModalContext.Provider>
          </AttachmentsProvider>
        </DatabasesProvider>
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
  const { database, status, sort, desc } = databasesRoute.useSearch()
  const { records, handleUpdateRecord, handleCreateRecord } = useDatabaseRecords()
  const { databases } = useWorkspaceDatabases()
  const navigate = useNavigate()
  const { open: createModalOpen, setOpen: setCreateModalOpen } = useCreateModal()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const selectedDatabase = getDatabaseProject(databases, database)

  // Get selected issue ID from child detail route
  const detailMatch = useMatch({
    from: issueDetailRoute.id,
    shouldThrow: false,
  })
  const selectedIdentifier = (detailMatch?.params as { recordId?: string })?.recordId ?? null

  const databaseRecords = useMemo(
    () => filterRecordsByDatabase(records, databases, database),
    [records, databases, database]
  )

  const filteredRecords = useMemo(
    () => (status ? databaseRecords.filter((record) => record.status === status) : databaseRecords),
    [databaseRecords, status]
  )

  const selectedRecord = useMemo(
    () =>
      selectedIdentifier
        ? databaseRecords.find((record) => record.identifier === selectedIdentifier) ?? null
        : null,
    [databaseRecords, selectedIdentifier]
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
        database,
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
    [sorting, navigate, database, status, selectedIdentifier]
  )

  const handleSelectRecord = useCallback(
    (record: DatabaseRecord) => {
      if (selectedRecord?.id === record.id) {
        void navigate({
          to: '/databases',
          search: { database, status, sort, desc },
        })
      } else {
        void navigate({
          to: '/databases/$recordId',
          params: { recordId: record.identifier },
          search: { database, status, sort, desc },
        })
      }
    },
    [navigate, database, status, sort, desc, selectedRecord]
  )

  const handleCreateRecordInDatabase = useCallback(
    (data: Parameters<typeof handleCreateRecord>[0]) => {
      handleCreateRecord({
        ...data,
        project: selectedDatabase?.label ?? data.project,
      })
    },
    [handleCreateRecord, selectedDatabase]
  )

  const handleStatusChange = useCallback(
    (nextStatus: Status | undefined) => {
      void navigate({
        to: '/databases',
        search: { database, ...(nextStatus ? { status: nextStatus } : {}), sort, desc },
      })
    },
    [navigate, database, sort, desc]
  )

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
        {/* Header */}
        <DatabaseHeader
          title="Databases"
          databaseLabel={selectedDatabase?.label ?? 'All databases'}
          currentView="table"
          database={database}
          status={status}
          onClearStatus={() =>
            void navigate({
              to: '/databases',
              search: { database, sort, desc },
            })
          }
          onCreate={() => setCreateModalOpen(true)}
          onToggleFilters={() => setFiltersOpen((current) => !current)}
          filtersOpen={filtersOpen}
        />

        {/* Table View */}
        <div className="flex-1 min-h-0 mt-1">
          <TableView
            issues={filteredRecords}
            selectedIssueId={selectedRecord?.id ?? null}
            onSelectIssue={handleSelectRecord}
            onUpdateIssue={handleUpdateRecord}
            onCreateIssue={handleCreateRecordInDatabase}
            sorting={sorting}
            onSortingChange={handleSortingChange}
          />
        </div>
      </div>
      <DatabaseStatusPanel
        open={filtersOpen}
        records={databaseRecords}
        status={status}
        onStatusChange={handleStatusChange}
      />
      </div>
      <Outlet />
      <CreateIssueModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateRecordInDatabase}
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
  const { database, status, sort, desc } = databasesRoute.useSearch()
  const { records, handleUpdateRecord, handleDeleteRecord } = useDatabaseRecords()
  const { databases } = useWorkspaceDatabases()
  const navigate = useNavigate()
  const databaseRecords = useMemo(
    () => filterRecordsByDatabase(records, databases, database),
    [records, databases, database]
  )

  const record = useMemo(
    () => databaseRecords.find((candidate) => candidate.identifier === recordId) ?? null,
    [databaseRecords, recordId]
  )

  return (
    <DetailPanel
      issue={record}
      onClose={() =>
        void navigate({ to: '/databases', search: { database, status, sort, desc } })
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
  validateSearch: (search: Record<string, unknown>): { database?: string; status?: Status } => ({
    database: typeof search.database === 'string' ? search.database : undefined,
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
  }),
  component: KanbanPage,
})

function KanbanPage() {
  const { database, status } = kanbanRoute.useSearch()
  const { records, handleMoveRecord, handleUpdateRecord, handleDeleteRecord, handleCreateRecord } = useDatabaseRecords()
  const { databases } = useWorkspaceDatabases()
  const [selectedRecord, setSelectedRecord] = useState<DatabaseRecord | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const navigate = useNavigate()
  const { open: createModalOpen, setOpen: setCreateModalOpen } = useCreateModal()
  const selectedDatabase = getDatabaseProject(databases, database)

  const databaseRecords = useMemo(
    () => filterRecordsByDatabase(records, databases, database),
    [records, databases, database]
  )

  const filteredRecords = useMemo(
    () => (status ? databaseRecords.filter((record) => record.status === status) : databaseRecords),
    [databaseRecords, status]
  )

  // Keep the selected record in sync with live data (handles edits & deletes)
  const liveSelectedRecord = useMemo(
    () => (selectedRecord ? databaseRecords.find((record) => record.id === selectedRecord.id) ?? null : null),
    [databaseRecords, selectedRecord]
  )

  const handleSelectRecord = useCallback(
    (record: DatabaseRecord) => {
      setSelectedRecord((prev) => (prev?.id === record.id ? null : record))
    },
    []
  )

  const handleCreateRecordInDatabase = useCallback(
    (data: Parameters<typeof handleCreateRecord>[0]) => {
      handleCreateRecord({
        ...data,
        project: selectedDatabase?.label ?? data.project,
      })
    },
    [handleCreateRecord, selectedDatabase]
  )

  const handleStatusChange = useCallback(
    (nextStatus: Status | undefined) => {
      void navigate({
        to: '/databases/board',
        search: { database, ...(nextStatus ? { status: nextStatus } : {}) },
      })
    },
    [navigate, database]
  )

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
        {/* Header */}
        <DatabaseHeader
          title="Board"
          databaseLabel={selectedDatabase?.label ?? 'All databases'}
          currentView="kanban"
          database={database}
          status={status}
          onClearStatus={() => void navigate({ to: '/databases/board', search: { database } })}
          onCreate={() => setCreateModalOpen(true)}
          onToggleFilters={() => setFiltersOpen((current) => !current)}
          filtersOpen={filtersOpen}
        />

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
      <DatabaseStatusPanel
        open={filtersOpen}
        records={databaseRecords}
        status={status}
        onStatusChange={handleStatusChange}
      />
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
        onCreate={handleCreateRecordInDatabase}
      />
    </>
  )
}

// ── Workflow Route (/databases/workflow) ───────────────────────

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'databases/workflow',
  validateSearch: (search: Record<string, unknown>): { database?: string } => ({
    database: typeof search.database === 'string' ? search.database : undefined,
  }),
  component: WorkflowPage,
})

function WorkflowPage() {
  const { database } = workflowRoute.useSearch()
  const { databases } = useWorkspaceDatabases()
  const { records, handleUpdateRecord, handleDeleteRecord } = useDatabaseRecords()
  const selectedDatabase = getDatabaseProject(databases, database)
  const databaseRecords = useMemo(
    () => filterRecordsByDatabase(records, databases, database),
    [records, databases, database]
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
      <DatabaseHeader
        title="Workflow"
        databaseLabel={selectedDatabase?.label ?? 'All databases'}
        currentView="workflow"
        database={database}
      />

      <div className="mt-1 min-h-0 flex-1">
        <WorkflowView
          databaseId={database ?? 'all'}
          records={databaseRecords}
          onUpdateRecord={handleUpdateRecord}
          onDeleteRecord={handleDeleteRecord}
        />
      </div>
    </div>
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
  workflowRoute,
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
