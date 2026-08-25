/* eslint-disable react-refresh/only-export-components */
import { createRoute, Outlet, redirect, useMatch, useNavigate } from '@tanstack/react-router'
import { useMemo, useCallback, useState, useEffect } from 'react'
import { TableView } from '../components/TableView'
import { KanbanView } from '../components/KanbanView'
import { WorkflowView } from '../components/WorkflowView'
import { DatabaseViewTabs } from '../components/DatabaseViewTabs'
import { DatabaseViewSettingsPanel } from '../components/DatabaseViewSettingsPanel'
import { DetailPanel } from '../components/DetailPanel'
import { CreateRecordModal } from '../components/CreateRecordModal'
import { Kbd } from '../components/Kbd'
import { useDatabaseRecords, useLiveRecords } from '../contexts/RecordsContext'
import { type WorkspaceDatabase, useWorkspaceDatabases } from '../contexts/DatabasesContext'
import { useDatabaseViews } from '../contexts/DatabaseViewsContext'
import { statusConfig, type Status, type DatabaseRecord } from '../data/mock'
import type { SortingState } from '@tanstack/react-table'
import {
  createViewFromLegacySearch,
  filterRecordsForDatabaseView,
  getDatabaseViewScopeId,
  getDefaultDatabaseViews,
  getDefaultDatabaseViewId,
  isRecordPropertyKey,
  sortRecordsForDatabaseView,
} from '../lib/databaseViews/databaseViews'
import {
  clearDatabaseViewDraft,
  loadDatabaseViewDraft,
  saveDatabaseViewDraft,
} from '../lib/databaseViews/drafts'
import type { DatabaseViewDefinition, DatabaseViewType } from '../lib/databaseViews/types'
import { rootRoute } from './root'
import { useCreateModal } from './createModal'
import { validateRecordSearch, type RecordSearchParams } from './searchParams'

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

function DatabaseHeader({
  title,
  databaseLabel,
  views,
  selectedView,
  dirty,
  status,
  onClearStatus,
  onCreate,
  onToggleFilters,
  filtersOpen,
  onSelectView,
  onCreateView,
  onRenameView,
  onDuplicateView,
  onDeleteView,
  onSaveView,
  onDiscardChanges,
}: {
  title: string
  databaseLabel: string
  views: DatabaseViewDefinition[]
  selectedView: DatabaseViewDefinition
  dirty: boolean
  status?: Status
  onClearStatus?: () => void
  onCreate?: () => void
  onToggleFilters?: () => void
  filtersOpen?: boolean
  onSelectView: (view: DatabaseViewDefinition) => void
  onCreateView: (type: DatabaseViewType) => void
  onRenameView: (view: DatabaseViewDefinition) => void
  onDuplicateView: (view: DatabaseViewDefinition) => void
  onDeleteView: (view: DatabaseViewDefinition) => void
  onSaveView: () => void
  onDiscardChanges: () => void
}) {
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
              data-testid="open-create-record"
              className="flex items-center gap-2 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium md:px-3"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={onCreate}
            >
              <span>+ New Record</span>
              <Kbd className="border-white/25 bg-white/15 text-white shadow-none">C</Kbd>
            </button>
          )}
        </div>
      </div>
      <DatabaseViewTabs
        views={views}
        selectedView={selectedView}
        dirty={dirty}
        onSelectView={onSelectView}
        onCreateView={onCreateView}
        onRenameView={onRenameView}
        onDuplicateView={onDuplicateView}
        onDeleteView={onDeleteView}
        onSaveView={onSaveView}
        onDiscardChanges={onDiscardChanges}
      />
    </div>
  )
}

// ── Databases Layout Route (/databases) ───────────────────────

export const databasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'databases',
  validateSearch: validateRecordSearch,
  component: DatabasesLayout,
})

function DatabasesLayout() {
  const { database, view: viewId, status, sort, desc } = databasesRoute.useSearch()
  const {
    handleMoveRecord,
    handleUpdateRecord,
    handleCreateRecord,
    handleDeleteRecord,
  } = useDatabaseRecords()
  const records = useLiveRecords()
  const { databases } = useWorkspaceDatabases()
  const {
    getViewsForDatabase,
    createDatabaseView,
    updateDatabaseView,
    renameDatabaseView,
    duplicateDatabaseView,
    deleteDatabaseView,
  } = useDatabaseViews()
  const navigate = useNavigate()
  const { open: createModalOpen, setOpen: setCreateModalOpen } = useCreateModal()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [draftView, setDraftView] = useState<DatabaseViewDefinition | null>(null)
  const selectedDatabase = getDatabaseProject(databases, database)
  const databaseScopeId = getDatabaseViewScopeId(database)
  const scopedViews = useMemo(
    () => getViewsForDatabase(database),
    [database, getViewsForDatabase]
  )
  const savedSelectedView = useMemo(
    () =>
      scopedViews.find((candidate) => candidate.id === viewId) ??
      scopedViews[0] ??
      getDefaultDatabaseViews(databaseScopeId)[0],
    [databaseScopeId, scopedViews, viewId]
  )

  // Get selected record ID from child detail route
  const detailMatch = useMatch({
    from: recordDetailRoute.id,
    shouldThrow: false,
  })
  const selectedIdentifier = (detailMatch?.params as { recordId?: string })?.recordId ?? null

  const navigateWithinDatabase = useCallback(
    (search: RecordSearchParams, replace = false) => {
      if (selectedIdentifier) {
        void navigate({
          to: '/databases/$recordId',
          params: { recordId: selectedIdentifier },
          search,
          replace,
        })
        return
      }

      void navigate({ to: '/databases', search, replace })
    },
    [navigate, selectedIdentifier]
  )

  useEffect(() => {
    if (!savedSelectedView || viewId === savedSelectedView.id) return
    navigateWithinDatabase(
      { database, view: savedSelectedView.id, status, sort, desc },
      true
    )
  }, [database, desc, navigateWithinDatabase, savedSelectedView, sort, status, viewId])

  useEffect(() => {
    if (!savedSelectedView) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setDraftView(loadDatabaseViewDraft(savedSelectedView))
    })
    return () => {
      cancelled = true
    }
  }, [savedSelectedView])

  const databaseRecords = useMemo(
    () => filterRecordsByDatabase(records, databases, database),
    [records, databases, database]
  )

  const selectedDraftView =
    draftView?.id === savedSelectedView?.id ? draftView : null
  const hasLegacySearch = Boolean(status || sort)
  const effectiveView = useMemo(
    () =>
      createViewFromLegacySearch(selectedDraftView ?? savedSelectedView, {
        status,
        sort,
        desc,
      }),
    [desc, savedSelectedView, selectedDraftView, sort, status]
  )
  const dirty = Boolean(selectedDraftView) || hasLegacySearch

  const filteredRecords = useMemo(
    () =>
      effectiveView.type === 'workflow'
        ? databaseRecords
        : filterRecordsForDatabaseView(databaseRecords, effectiveView),
    [databaseRecords, effectiveView]
  )
  const sortedRecords = useMemo(
    () => sortRecordsForDatabaseView(filteredRecords, effectiveView),
    [effectiveView, filteredRecords]
  )

  const selectedRecord = useMemo(
    () =>
      selectedIdentifier
        ? databaseRecords.find((record) => record.identifier === selectedIdentifier) ?? null
        : null,
    [databaseRecords, selectedIdentifier]
  )

  const sorting: SortingState = useMemo(
    () =>
      effectiveView.sorting
        ? [{ id: effectiveView.sorting.id, desc: effectiveView.sorting.desc }]
        : [],
    [effectiveView.sorting]
  )

  const updateDraftView = useCallback(
    (
      updater:
        | DatabaseViewDefinition
        | ((current: DatabaseViewDefinition) => DatabaseViewDefinition)
    ) => {
      setDraftView((current) => {
        const base = current?.id === savedSelectedView.id
          ? current
          : createViewFromLegacySearch(savedSelectedView, { status, sort, desc })
        const next = typeof updater === 'function' ? updater(base) : updater
        const draft = { ...next, id: savedSelectedView.id, databaseId: savedSelectedView.databaseId }
        saveDatabaseViewDraft(draft)
        return draft
      })
    },
    [desc, savedSelectedView, sort, status]
  )

  const handleSortingChange = useCallback(
    (updater: SortingState | ((prev: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === 'function' ? updater(sorting) : updater
      const first = newSorting[0]
      updateDraftView((current) => ({
        ...current,
        sorting: first && isRecordPropertyKey(first.id)
          ? { id: first.id, desc: first.desc ?? false }
          : null,
      }))
    },
    [sorting, updateDraftView]
  )

  const handleSelectRecord = useCallback(
    (recordId: string) => {
      if (selectedRecord?.id === recordId) {
        void navigate({
          to: '/databases',
          search: { database, view: savedSelectedView.id },
        })
        return
      }
      const record = databaseRecords.find((candidate) => candidate.id === recordId)
      if (!record) return
      void navigate({
        to: '/databases/$recordId',
        params: { recordId: record.identifier },
        search: { database, view: savedSelectedView.id },
      })
    },
    [database, databaseRecords, navigate, savedSelectedView.id, selectedRecord]
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

  const handleSaveView = useCallback(() => {
    updateDatabaseView(effectiveView)
    clearDatabaseViewDraft(savedSelectedView)
    setDraftView(null)
    navigateWithinDatabase({ database, view: savedSelectedView.id }, true)
  }, [
    database,
    effectiveView,
    navigateWithinDatabase,
    savedSelectedView,
    updateDatabaseView,
  ])

  const handleDiscardChanges = useCallback(() => {
    clearDatabaseViewDraft(savedSelectedView)
    setDraftView(null)
    navigateWithinDatabase({ database, view: savedSelectedView.id }, true)
  }, [database, navigateWithinDatabase, savedSelectedView])

  const handleSelectView = useCallback(
    (nextView: DatabaseViewDefinition) => {
      void navigate({
        to: '/databases',
        search: { database, view: nextView.id },
      })
    },
    [database, navigate]
  )

  const handleCreateView = useCallback(
    (type: DatabaseViewType) => {
      const nextView = createDatabaseView(database, type)
      void navigate({
        to: '/databases',
        search: { database, view: nextView.id },
      })
    },
    [createDatabaseView, database, navigate]
  )

  const handleRenameView = useCallback(
    (view: DatabaseViewDefinition) => {
      const name = window.prompt('View name', view.name)
      if (name) renameDatabaseView(view.id, name)
    },
    [renameDatabaseView]
  )

  const handleDuplicateView = useCallback(
    (view: DatabaseViewDefinition) => {
      const nextView = duplicateDatabaseView(view)
      void navigate({
        to: '/databases',
        search: { database, view: nextView.id },
      })
    },
    [database, duplicateDatabaseView, navigate]
  )

  const handleDeleteView = useCallback(
    (view: DatabaseViewDefinition) => {
      deleteDatabaseView(view)
      const nextView = scopedViews.find((candidate) => candidate.id !== view.id)
      if (nextView) {
        void navigate({
          to: '/databases',
          search: { database, view: nextView.id },
        })
      }
    },
    [database, deleteDatabaseView, navigate, scopedViews]
  )

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
        {/* Header */}
        <DatabaseHeader
          title="Databases"
          databaseLabel={selectedDatabase?.label ?? 'All databases'}
          views={scopedViews}
          selectedView={savedSelectedView}
          dirty={dirty}
          status={effectiveView.filters.status}
          onClearStatus={() =>
            updateDraftView((current) => ({
              ...current,
              filters: { ...current.filters, status: undefined },
            }))
          }
          onCreate={() => setCreateModalOpen(true)}
          onToggleFilters={
            effectiveView.type === 'workflow'
              ? undefined
              : () => setFiltersOpen((current) => !current)
          }
          filtersOpen={filtersOpen}
          onSelectView={handleSelectView}
          onCreateView={handleCreateView}
          onRenameView={handleRenameView}
          onDuplicateView={handleDuplicateView}
          onDeleteView={handleDeleteView}
          onSaveView={handleSaveView}
          onDiscardChanges={handleDiscardChanges}
        />

        <div className="flex-1 min-h-0 mt-1">
          {effectiveView.type === 'table' && (
            <TableView
              records={filteredRecords}
              selectedRecordId={selectedRecord?.id ?? null}
              onSelectRecord={handleSelectRecord}
              onUpdateRecord={handleUpdateRecord}
              onCreateRecord={handleCreateRecordInDatabase}
              sorting={sorting}
              onSortingChange={handleSortingChange}
              globalFilter={effectiveView.filters.search}
              onGlobalFilterChange={(searchValue) =>
                updateDraftView((current) => ({
                  ...current,
                  filters: { ...current.filters, search: searchValue },
                }))
              }
              visibleProperties={effectiveView.visibleProperties}
            />
          )}
          {effectiveView.type === 'board' && (
            <KanbanView
              records={sortedRecords}
              selectedRecordId={selectedRecord?.id ?? null}
              onSelectRecord={handleSelectRecord}
              onMoveRecord={handleMoveRecord}
              compact={effectiveView.board.compact}
              onCompactChange={(compact) =>
                updateDraftView((current) => ({
                  ...current,
                  board: { ...current.board, compact },
                }))
              }
              visibleProperties={effectiveView.visibleProperties}
            />
          )}
          {effectiveView.type === 'workflow' && (
            <WorkflowView
              databaseId={effectiveView.workflowCanvasKey}
              records={databaseRecords}
              onUpdateRecord={handleUpdateRecord}
              onDeleteRecord={handleDeleteRecord}
            />
          )}
        </div>
      </div>
      <DatabaseViewSettingsPanel
        open={filtersOpen}
        records={databaseRecords}
        view={effectiveView}
        onChangeView={updateDraftView}
      />
      </div>
      <Outlet />
      <CreateRecordModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateRecordInDatabase}
      />
    </>
  )
}

// ── Databases Index Route (no detail panel) ───────────────────

export const recordsIndexRoute = createRoute({
  getParentRoute: () => databasesRoute,
  path: '/',
  component: () => null,
})

// ── Record Detail Route (/databases/$recordId) ────────────────

export const recordDetailRoute = createRoute({
  getParentRoute: () => databasesRoute,
  path: '$recordId',
  component: RecordDetailPanel,
})

function RecordDetailPanel() {
  const { recordId } = recordDetailRoute.useParams()
  const { database, view } = databasesRoute.useSearch()
  const { handleUpdateRecord, handleDeleteRecord } = useDatabaseRecords()
  const records = useLiveRecords()
  const { databases } = useWorkspaceDatabases()
  const navigate = useNavigate()
  const databaseRecords = useMemo(
    () => filterRecordsByDatabase(records, databases, database),
    [records, databases, database]
  )

  // The live query renders straight from the engine, so a deep link resolves as
  // soon as the engine loads — there is no stale cache to re-hydrate around.
  const record = useMemo(
    () => databaseRecords.find((candidate) => candidate.identifier === recordId) ?? null,
    [databaseRecords, recordId]
  )

  return (
    <DetailPanel
      record={record}
      onClose={() =>
        void navigate({ to: '/databases', search: { database, view } })
      }
      onUpdateRecord={handleUpdateRecord}
      onDeleteRecord={handleDeleteRecord}
    />
  )
}

// ── Board Route (/databases/board) ────────────────────────────

export const kanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'databases/board',
  validateSearch: (search: Record<string, unknown>): { database?: string; status?: Status } => ({
    database: typeof search.database === 'string' ? search.database : undefined,
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
  }),
  beforeLoad: ({ search }) => {
    const databaseId = getDatabaseViewScopeId(search.database)
    throw redirect({
      to: '/databases',
      search: {
        database: search.database,
        view: getDefaultDatabaseViewId(databaseId, 'board'),
        ...(search.status ? { status: search.status } : {}),
      },
    })
  },
})

// ── Workflow Route (/databases/workflow) ───────────────────────

export const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'databases/workflow',
  validateSearch: (search: Record<string, unknown>): { database?: string } => ({
    database: typeof search.database === 'string' ? search.database : undefined,
  }),
  beforeLoad: ({ search }) => {
    const databaseId = getDatabaseViewScopeId(search.database)
    throw redirect({
      to: '/databases',
      search: {
        database: search.database,
        view: getDefaultDatabaseViewId(databaseId, 'workflow'),
      },
    })
  },
})

// ── Legacy Route Redirects ────────────────────────────────────

export const legacyKanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'kanban',
  beforeLoad: () => {
    throw redirect({
      to: '/databases',
      search: {
        view: getDefaultDatabaseViewId(getDatabaseViewScopeId(undefined), 'board'),
      },
    })
  },
})
