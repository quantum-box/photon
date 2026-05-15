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
import { useWorkspaceDatabases } from './DatabasesContext'
import {
  databaseViewsArray,
  initialSyncReady,
  workflowCanvasesMap,
  ydoc,
} from '../lib/yjs/yjsProvider'
import {
  ALL_DATABASES_ID,
  createNewDatabaseView,
  getDefaultDatabaseViews,
  getDatabaseViewScopeId,
  normalizeDatabaseView,
  writeDatabaseViewToYMap,
  ymapToDatabaseView,
} from '../lib/databaseViews/databaseViews'
import type { DatabaseViewDefinition, DatabaseViewType } from '../lib/databaseViews/types'

interface DatabaseViewsContextValue {
  views: DatabaseViewDefinition[]
  getViewsForDatabase: (databaseId: string | undefined) => DatabaseViewDefinition[]
  createDatabaseView: (
    databaseId: string | undefined,
    type: DatabaseViewType
  ) => DatabaseViewDefinition
  updateDatabaseView: (view: DatabaseViewDefinition) => void
  renameDatabaseView: (viewId: string, name: string) => void
  duplicateDatabaseView: (view: DatabaseViewDefinition) => DatabaseViewDefinition
  deleteDatabaseView: (view: DatabaseViewDefinition) => void
}

const DatabaseViewsContext = createContext<DatabaseViewsContextValue | null>(null)

function snapshotDatabaseViews(): DatabaseViewDefinition[] {
  const result = new Map<string, DatabaseViewDefinition>()
  databaseViewsArray.forEach((ymap) => {
    const view = ymapToDatabaseView(ymap)
    if (view.id && view.databaseId) result.set(view.id, view)
  })
  return [...result.values()]
}

function findYView(id: string): Y.Map<string> | null {
  for (let i = 0; i < databaseViewsArray.length; i++) {
    const ymap = databaseViewsArray.get(i)
    if (ymap.get('id') === id) return ymap
  }
  return null
}

function removeDuplicateYDatabaseViews(id: string, keep: Y.Map<string>) {
  for (let i = databaseViewsArray.length - 1; i >= 0; i--) {
    const ymap = databaseViewsArray.get(i)
    if (ymap !== keep && ymap.get('id') === id) {
      databaseViewsArray.delete(i, 1)
    }
  }
}

function upsertYDatabaseView(view: DatabaseViewDefinition) {
  const normalized = normalizeDatabaseView(view)
  const existing = findYView(normalized.id)
  if (existing) {
    writeDatabaseViewToYMap(existing, normalized)
    removeDuplicateYDatabaseViews(normalized.id, existing)
    return
  }

  const ymap = new Y.Map<string>()
  writeDatabaseViewToYMap(ymap, normalized)
  databaseViewsArray.push([ymap])
}

function ensureDefaultViewsForDatabase(databaseId: string) {
  getDefaultDatabaseViews(databaseId).forEach(upsertYDatabaseView)
}

function removeYDatabaseView(viewId: string) {
  for (let i = 0; i < databaseViewsArray.length; i++) {
    if (databaseViewsArray.get(i).get('id') === viewId) {
      databaseViewsArray.delete(i, 1)
      return
    }
  }
}

function byDatabaseAndOrder(a: DatabaseViewDefinition, b: DatabaseViewDefinition) {
  if (a.databaseId !== b.databaseId) return a.databaseId.localeCompare(b.databaseId)
  if (a.order !== b.order) return a.order - b.order
  return a.createdAt.localeCompare(b.createdAt)
}

export function DatabaseViewsProvider({ children }: { children: ReactNode }) {
  const { databases } = useWorkspaceDatabases()
  const [views, setViews] = useState<DatabaseViewDefinition[]>([])
  const [ready, setReady] = useState(false)

  const refreshViews = useCallback(() => {
    setViews(snapshotDatabaseViews().sort(byDatabaseAndOrder))
  }, [])

  useEffect(() => {
    let rafId: number | null = null
    let unmounted = false
    let observing = false

    function updateSnapshot() {
      if (unmounted) return
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!unmounted) setViews(snapshotDatabaseViews().sort(byDatabaseAndOrder))
      })
    }

    initialSyncReady.then(() => {
      if (unmounted) return
      setReady(true)
      refreshViews()
      databaseViewsArray.observeDeep(updateSnapshot)
      observing = true
    })

    return () => {
      unmounted = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (observing) databaseViewsArray.unobserveDeep(updateSnapshot)
    }
  }, [refreshViews])

  useEffect(() => {
    if (!ready) return
    const databaseIds = [ALL_DATABASES_ID, ...databases.map((database) => database.id)]
    ydoc.transact(() => {
      databaseIds.forEach(ensureDefaultViewsForDatabase)
    })
    const rafId = requestAnimationFrame(refreshViews)
    return () => cancelAnimationFrame(rafId)
  }, [databases, ready, refreshViews])

  const getViewsForDatabase = useCallback(
    (databaseId: string | undefined) => {
      const scopedDatabaseId = getDatabaseViewScopeId(databaseId)
      const scopedViews = views
        .filter((view) => view.databaseId === scopedDatabaseId)
        .sort(byDatabaseAndOrder)
      return scopedViews.length > 0 ? scopedViews : getDefaultDatabaseViews(scopedDatabaseId)
    },
    [views]
  )

  const createDatabaseView = useCallback(
    (databaseId: string | undefined, type: DatabaseViewType) => {
      const scopedDatabaseId = getDatabaseViewScopeId(databaseId)
      const existing = getViewsForDatabase(scopedDatabaseId)
      const view = createNewDatabaseView(scopedDatabaseId, type, existing.length)
      ydoc.transact(() => upsertYDatabaseView(view))
      refreshViews()
      return view
    },
    [getViewsForDatabase, refreshViews]
  )

  const updateDatabaseView = useCallback((view: DatabaseViewDefinition) => {
    ydoc.transact(() => {
      upsertYDatabaseView({ ...view, updatedAt: new Date().toISOString() })
    })
    refreshViews()
  }, [refreshViews])

  const renameDatabaseView = useCallback(
    (viewId: string, name: string) => {
      const view = views.find((candidate) => candidate.id === viewId)
      const trimmedName = name.trim()
      if (!view || !trimmedName) return
      updateDatabaseView({ ...view, name: trimmedName })
    },
    [updateDatabaseView, views]
  )

  const duplicateDatabaseView = useCallback(
    (view: DatabaseViewDefinition) => {
      const existing = getViewsForDatabase(view.databaseId)
      const duplicate = createNewDatabaseView(
        view.databaseId,
        view.type,
        existing.length,
        `${view.name} Copy`
      )
      const nextView: DatabaseViewDefinition = {
        ...duplicate,
        filters: view.filters,
        sorting: view.sorting,
        visibleProperties: view.visibleProperties,
        board: view.board,
      }

      ydoc.transact(() => {
        if (view.type === 'workflow') {
          const canvas = workflowCanvasesMap.get(view.workflowCanvasKey)
          if (canvas) workflowCanvasesMap.set(nextView.workflowCanvasKey, canvas)
        }
        upsertYDatabaseView(nextView)
      })
      refreshViews()
      return nextView
    },
    [getViewsForDatabase, refreshViews]
  )

  const deleteDatabaseView = useCallback(
    (view: DatabaseViewDefinition) => {
      const existing = getViewsForDatabase(view.databaseId)
      if (existing.length <= 1) return
      ydoc.transact(() => removeYDatabaseView(view.id))
      refreshViews()
    },
    [getViewsForDatabase, refreshViews]
  )

  const value = useMemo(
    () => ({
      views,
      getViewsForDatabase,
      createDatabaseView,
      updateDatabaseView,
      renameDatabaseView,
      duplicateDatabaseView,
      deleteDatabaseView,
    }),
    [
      createDatabaseView,
      deleteDatabaseView,
      duplicateDatabaseView,
      getViewsForDatabase,
      renameDatabaseView,
      updateDatabaseView,
      views,
    ]
  )

  return (
    <DatabaseViewsContext.Provider value={value}>{children}</DatabaseViewsContext.Provider>
  )
}

export function useDatabaseViews() {
  const context = useContext(DatabaseViewsContext)
  if (!context) {
    throw new Error('useDatabaseViews must be used within DatabaseViewsProvider')
  }
  return context
}
