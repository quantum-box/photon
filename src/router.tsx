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
import { useMemo, useCallback, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { KanbanView } from './components/KanbanView'
import { DetailPanel } from './components/DetailPanel'
import { ChatView } from './components/chat/ChatView'
import { IssuesProvider, useIssues } from './contexts/IssuesContext'
import type { Status, Issue } from './data/mock'
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

// ── Root Route ─────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: function RootLayout() {
    return (
      <IssuesProvider>
        <div className="flex h-full">
          <Sidebar />
          <Outlet />
        </div>
      </IssuesProvider>
    )
  },
})

// ── Index Route (redirect → /issues) ──────────────────────────

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/issues' })
  },
})

// ── Issues Layout Route (/issues) ─────────────────────────────

const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'issues',
  validateSearch: validateIssueSearch,
  component: IssuesLayout,
})

function IssuesLayout() {
  const { status, sort, desc } = issuesRoute.useSearch()
  const { issues, handleUpdateIssue, handleCreateIssue } = useIssues()
  const navigate = useNavigate()

  // Get selected issue ID from child detail route
  const detailMatch = useMatch({
    from: issueDetailRoute.id,
    shouldThrow: false,
  })
  const selectedIdentifier = (detailMatch?.params as { issueId?: string })?.issueId ?? null

  const filteredIssues = useMemo(
    () => (status ? issues.filter((i) => i.status === status) : issues),
    [issues, status]
  )

  const selectedIssue = useMemo(
    () =>
      selectedIdentifier
        ? issues.find((i) => i.identifier === selectedIdentifier) ?? null
        : null,
    [issues, selectedIdentifier]
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
          to: '/issues/$issueId',
          params: { issueId: selectedIdentifier },
          search: newSearch,
          replace: true,
        })
      } else {
        void navigate({
          to: '/issues',
          search: newSearch,
          replace: true,
        })
      }
    },
    [sorting, navigate, status, selectedIdentifier]
  )

  const handleSelectIssue = useCallback(
    (issue: Issue) => {
      if (selectedIssue?.id === issue.id) {
        void navigate({
          to: '/issues',
          search: { status, sort, desc },
        })
      } else {
        void navigate({
          to: '/issues/$issueId',
          params: { issueId: issue.identifier },
          search: { status, sort, desc },
        })
      }
    },
    [navigate, status, sort, desc, selectedIssue]
  )

  return (
    <>
      <div className="flex-1 flex flex-col min-w-0 p-2">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold">Issues</h1>
            {status && (
              <span className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1 bg-surface-hover text-muted">
                {status}
                <button
                  onClick={() =>
                    void navigate({
                      to: '/issues',
                      search: { sort, desc },
                    })
                  }
                  className="ml-1 text-subtle hover:opacity-75"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-white">
              + New Issue
            </button>
          </div>
        </div>

        {/* Table View */}
        <div className="flex-1 min-h-0 mt-1">
          <TableView
            issues={filteredIssues}
            selectedIssueId={selectedIssue?.id ?? null}
            onSelectIssue={handleSelectIssue}
            onUpdateIssue={handleUpdateIssue}
            onCreateIssue={handleCreateIssue}
            sorting={sorting}
            onSortingChange={handleSortingChange}
          />
        </div>
      </div>
      <Outlet />
    </>
  )
}

// ── Issues Index Route (no detail panel) ──────────────────────

const issuesIndexRoute = createRoute({
  getParentRoute: () => issuesRoute,
  path: '/',
  component: () => null,
})

// ── Issue Detail Route (/issues/$issueId) ─────────────────────

const issueDetailRoute = createRoute({
  getParentRoute: () => issuesRoute,
  path: '$issueId',
  component: IssueDetailPanel,
})

function IssueDetailPanel() {
  const { issueId } = issueDetailRoute.useParams()
  const { status, sort, desc } = issuesRoute.useSearch()
  const { issues } = useIssues()
  const navigate = useNavigate()

  const issue = useMemo(
    () => issues.find((i) => i.identifier === issueId) ?? null,
    [issues, issueId]
  )

  return (
    <DetailPanel
      issue={issue}
      onClose={() =>
        void navigate({ to: '/issues', search: { status, sort, desc } })
      }
    />
  )
}

// ── Kanban Route (/kanban) ────────────────────────────────────

const kanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'kanban',
  validateSearch: (search: Record<string, unknown>): { status?: Status } => ({
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
  }),
  component: KanbanPage,
})

function KanbanPage() {
  const { status } = kanbanRoute.useSearch()
  const { issues, handleMoveIssue } = useIssues()
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const navigate = useNavigate()

  const filteredIssues = useMemo(
    () => (status ? issues.filter((i) => i.status === status) : issues),
    [issues, status]
  )

  const handleSelectIssue = useCallback(
    (issue: Issue) => {
      setSelectedIssue((prev) => (prev?.id === issue.id ? null : issue))
    },
    []
  )

  return (
    <>
      <div className="flex-1 flex flex-col min-w-0 p-2">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold">Board</h1>
            {status && (
              <span className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1 bg-surface-hover text-muted">
                {status}
                <button
                  onClick={() =>
                    void navigate({ to: '/kanban', search: {} })
                  }
                  className="ml-1 text-subtle hover:opacity-75"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-white">
              + New Issue
            </button>
          </div>
        </div>

        {/* Kanban View */}
        <div className="flex-1 min-h-0 mt-1">
          <KanbanView
            issues={filteredIssues}
            selectedIssueId={selectedIssue?.id ?? null}
            onSelectIssue={handleSelectIssue}
            onMoveIssue={handleMoveIssue}
          />
        </div>
      </div>
      {selectedIssue && (
        <DetailPanel
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}
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
    <div className="flex-1 flex flex-col min-w-0 p-2">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
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

// ── Route Tree & Router ───────────────────────────────────────

const routeTree = rootRoute.addChildren([
  indexRoute,
  issuesRoute.addChildren([issuesIndexRoute, issueDetailRoute]),
  kanbanRoute,
  chatRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
