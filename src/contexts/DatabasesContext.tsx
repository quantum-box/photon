/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as Y from 'yjs'
import { appKitConfig } from '../app/kitConfig'
import { databasesArray, initialSyncReady, ydoc } from '../lib/yjs/yjsProvider'

export interface WorkspaceDatabase {
  id: string
  label: string
}

interface DatabasesContextValue {
  databases: WorkspaceDatabase[]
  addDatabase: (label: string) => WorkspaceDatabase | null
  removeDatabase: (databaseId: string) => boolean
  canRemoveDatabase: (databaseId: string | null | undefined) => boolean
  getDatabase: (databaseId: string | undefined) => WorkspaceDatabase | null
}

const LOCAL_STORAGE_KEY = 'photon-workspace-databases'

const baseDatabases: WorkspaceDatabase[] = appKitConfig.workspace.projects.map((project) => ({
  id: project.id,
  label: project.label,
}))

const DatabasesContext = createContext<DatabasesContextValue | null>(null)

function slugifyDatabaseLabel(label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || `database-${Date.now()}`
}

function readStoredDatabases(): WorkspaceDatabase[] {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (item): item is WorkspaceDatabase =>
        item &&
        typeof item.id === 'string' &&
        typeof item.label === 'string' &&
        item.id.length > 0 &&
        item.label.length > 0
    )
  } catch {
    return []
  }
}

function ymapToDatabase(ymap: Y.Map<string>): WorkspaceDatabase {
  return {
    id: (ymap.get('id') as string) ?? '',
    label: (ymap.get('label') as string) ?? '',
  }
}

function snapshotDatabases(): WorkspaceDatabase[] {
  const result = new Map<string, WorkspaceDatabase>()
  databasesArray.forEach((ymap) => {
    const database = ymapToDatabase(ymap)
    if (database.id && database.label) {
      result.set(database.id, database)
    }
  })
  return [...result.values()]
}

function findYDatabase(id: string): Y.Map<string> | null {
  for (let i = 0; i < databasesArray.length; i++) {
    const ymap = databasesArray.get(i)
    if (ymap.get('id') === id) return ymap
  }
  return null
}

function upsertYDatabase(database: WorkspaceDatabase) {
  const existing = findYDatabase(database.id)
  if (existing) {
    existing.set('id', database.id)
    existing.set('label', database.label)
    removeDuplicateYDatabases(database.id, existing)
    return
  }

  const ymap = new Y.Map<string>()
  ymap.set('id', database.id)
  ymap.set('label', database.label)
  databasesArray.push([ymap])
}

function deleteYDatabase(id: string) {
  for (let i = databasesArray.length - 1; i >= 0; i--) {
    const ymap = databasesArray.get(i)
    if (ymap.get('id') === id) {
      databasesArray.delete(i, 1)
    }
  }
}

function removeDuplicateYDatabases(id: string, keep: Y.Map<string>) {
  for (let i = databasesArray.length - 1; i >= 0; i--) {
    const ymap = databasesArray.get(i)
    if (ymap !== keep && ymap.get('id') === id) {
      databasesArray.delete(i, 1)
    }
  }
}

export function DatabasesProvider({ children }: { children: ReactNode }) {
  const [customDatabases, setCustomDatabases] = useState<WorkspaceDatabase[]>([])
  const baseDatabaseIds = useMemo(
    () => new Set(baseDatabases.map((database) => database.id)),
    []
  )

  useEffect(() => {
    let rafId: number | null = null
    let unmounted = false
    let observing = false

    function updateSnapshot() {
      if (unmounted) return
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!unmounted) setCustomDatabases(snapshotDatabases())
      })
    }

    initialSyncReady.then(() => {
      if (unmounted) return

      const storedDatabases = readStoredDatabases()
      if (storedDatabases.length > 0) {
        ydoc.transact(() => {
          storedDatabases.forEach(upsertYDatabase)
        })
        window.localStorage.removeItem(LOCAL_STORAGE_KEY)
      }

      setCustomDatabases(snapshotDatabases())
      databasesArray.observeDeep(updateSnapshot)
      observing = true
    })

    return () => {
      unmounted = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (observing) {
        databasesArray.unobserveDeep(updateSnapshot)
      }
    }
  }, [])

  const databases = useMemo(() => {
    const custom = customDatabases.filter((database) => !baseDatabaseIds.has(database.id))
    return [...baseDatabases, ...custom]
  }, [baseDatabaseIds, customDatabases])

  const getDatabase = useCallback(
    (databaseId: string | undefined) =>
      databases.find((database) => database.id === databaseId) ?? null,
    [databases]
  )

  const canRemoveDatabase = useCallback(
    (databaseId: string | null | undefined) => Boolean(databaseId && !baseDatabaseIds.has(databaseId)),
    [baseDatabaseIds]
  )

  const addDatabase = useCallback(
    (label: string) => {
      const trimmedLabel = label.trim()
      if (!trimmedLabel) return null

      const existingByLabel = databases.find(
        (database) => database.label.toLowerCase() === trimmedLabel.toLowerCase()
      )
      if (existingByLabel) return existingByLabel

      const baseId = slugifyDatabaseLabel(trimmedLabel)
      const existingIds = new Set(databases.map((database) => database.id))
      let id = baseId
      let suffix = 2
      while (existingIds.has(id)) {
        id = `${baseId}-${suffix}`
        suffix += 1
      }

      const nextDatabase = { id, label: trimmedLabel }
      setCustomDatabases((current) =>
        current.some((database) => database.id === nextDatabase.id)
          ? current
          : [...current, nextDatabase]
      )
      ydoc.transact(() => {
        upsertYDatabase(nextDatabase)
      })
      return nextDatabase
    },
    [databases]
  )

  const removeDatabase = useCallback(
    (databaseId: string) => {
      if (!canRemoveDatabase(databaseId)) return false

      setCustomDatabases((current) =>
        current.filter((database) => database.id !== databaseId)
      )
      ydoc.transact(() => {
        deleteYDatabase(databaseId)
      })
      return true
    },
    [canRemoveDatabase]
  )

  const value = useMemo(
    () => ({ databases, addDatabase, removeDatabase, canRemoveDatabase, getDatabase }),
    [addDatabase, canRemoveDatabase, databases, getDatabase, removeDatabase]
  )

  return <DatabasesContext.Provider value={value}>{children}</DatabasesContext.Provider>
}

export function useWorkspaceDatabases() {
  const context = useContext(DatabasesContext)
  if (!context) {
    throw new Error('useWorkspaceDatabases must be used within DatabasesProvider')
  }
  return context
}
