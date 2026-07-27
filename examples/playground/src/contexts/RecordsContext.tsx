/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import * as Y from 'yjs'
import { ydoc, recordsArray } from '../lib/yjs/yjsProvider'
import { useYjsRecords } from '../lib/yjs/useYjsRecords'
import {
  createServerRecord,
  deleteServerRecord,
  fetchServerRecords,
  playgroundSeedSettled,
  updateServerRecord,
  type ServerUpdateRecordData,
} from '../lib/recordsApi'
import {
  mockDatabaseRecords,
  type DatabaseRecord,
  type Status,
  type Priority,
} from '../data/mock'
import { appKitConfig } from '../app/kitConfig'

export interface CreateRecordData {
  title: string
  status?: Status
  priority?: Priority
  assignee?: string | null
  description?: string
  labels?: string[]
  project?: string
}

interface RecordsContextValue {
  records: DatabaseRecord[]
  handleMoveRecord: (recordId: string, newStatus: Status) => void
  handleUpdateRecord: (recordId: string, field: keyof DatabaseRecord, value: string) => void
  handleCreateRecord: (data: CreateRecordData) => Promise<void>
  handleDeleteRecord: (recordId: string) => void
  syncRecord: (record: DatabaseRecord) => void
  syncRecords: (records: DatabaseRecord[]) => void
  recordCountByStatus: Record<string, number>
}

const RecordsContext = createContext<RecordsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findYMap(id: string): Y.Map<string> | null {
  for (let i = 0; i < recordsArray.length; i++) {
    const ymap = recordsArray.get(i)
    if (ymap.get('id') === id) return ymap
  }
  return null
}

function removeDuplicateYRecords(id: string, keep: Y.Map<string>) {
  for (let i = recordsArray.length - 1; i >= 0; i--) {
    const ymap = recordsArray.get(i)
    if (ymap !== keep && ymap.get('id') === id) {
      recordsArray.delete(i, 1)
    }
  }
}

function writeRecordToYMap(ymap: Y.Map<string>, record: DatabaseRecord) {
  ymap.set('id', record.id)
  ymap.set('identifier', record.identifier)
  ymap.set('title', record.title)
  ymap.set('status', record.status)
  ymap.set('priority', record.priority)
  ymap.set('assignee', record.assignee ?? '')
  ymap.set('labels', JSON.stringify(record.labels))
  ymap.set('project', record.project)
  ymap.set('createdAt', record.createdAt)
  ymap.set('updatedAt', record.updatedAt)
  ymap.set('description', record.description)
}

function upsertYDatabaseRecord(record: DatabaseRecord) {
  const existing = findYMap(record.id)
  if (existing) {
    writeRecordToYMap(existing, record)
    removeDuplicateYRecords(record.id, existing)
    return
  }

  const ymap = new Y.Map<string>()
  writeRecordToYMap(ymap, record)
  recordsArray.push([ymap])
}

function removeYDatabaseRecord(recordId: string) {
  for (let i = 0; i < recordsArray.length; i++) {
    if (recordsArray.get(i).get('id') === recordId) {
      recordsArray.delete(i, 1)
      return
    }
  }
}

function reconcileYRecords(serverRecords: DatabaseRecord[]) {
  for (const record of serverRecords) {
    upsertYDatabaseRecord(record)
  }
}

function parseLabels(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((label): label is string => typeof label === 'string')
      : []
  } catch {
    return []
  }
}

function serverUpdateForField(
  field: keyof DatabaseRecord,
  value: string
): ServerUpdateRecordData {
  switch (field) {
    case 'title':
      return { title: value }
    case 'description':
      return { description: value }
    case 'status':
      return { status: value as Status }
    case 'priority':
      return { priority: value as Priority }
    case 'assignee':
      return { assignee: value || null }
    case 'labels':
      return { labels: parseLabels(value) }
    case 'project':
      return { project: value }
    default:
      return {}
  }
}

function optimisticRecordId() {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `optimistic-record-${randomId}`
}

function createOptimisticDatabaseRecord(data: CreateRecordData): DatabaseRecord {
  const now = new Date().toISOString()
  return {
    id: optimisticRecordId(),
    identifier: `${appKitConfig.records.identifierPrefix}-NEW`,
    title: data.title,
    status: data.status ?? 'todo',
    priority: data.priority ?? 'none',
    assignee: data.assignee ?? null,
    labels: data.labels ?? [],
    project: data.project ?? appKitConfig.records.defaultProject,
    createdAt: now,
    updatedAt: now,
    description: data.description ?? '',
  }
}

function seedMockData() {
  ydoc.transact(() => {
    for (const record of mockDatabaseRecords) {
      upsertYDatabaseRecord(record)
    }
  })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function RecordsProvider({ children }: { children: ReactNode }) {
  const { records, ready } = useYjsRecords()

  // Hydrate the Yjs projection from the canonical record API. If the app server
  // is unavailable in local/offline use, keep the existing local-first fallback.
  useEffect(() => {
    if (!ready) return

    let cancelled = false

    // Wait for a bootstrap seed that is already running, so the first read does
    // not observe a half-populated engine and leave the app empty until reload.
    playgroundSeedSettled()
      .then(fetchServerRecords)
      .then((serverRecords) => {
        if (cancelled) return
        ydoc.transact(() => {
          reconcileYRecords(serverRecords)
        })
      })
      .catch((error: unknown) => {
        console.warn('Failed to hydrate records from the application server', error)
        if (!cancelled && recordsArray.length === 0) {
          seedMockData()
        }
      })

    return () => {
      cancelled = true
    }
  }, [ready])

  const recordCountByStatus = useMemo(
    () =>
      records.reduce(
        (acc, record) => {
          acc[record.status] = (acc[record.status] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ),
    [records]
  )

  const handleMoveRecord = useCallback((recordId: string, newStatus: Status) => {
    void updateServerRecord(recordId, { status: newStatus })
      .then((serverRecord) => {
        ydoc.transact(() => upsertYDatabaseRecord(serverRecord))
      })
      .catch((error: unknown) => {
        console.warn('Failed to persist record status update', error)
      })
  }, [])

  const handleUpdateRecord = useCallback(
    (recordId: string, field: keyof DatabaseRecord, value: string) => {
      const serverUpdate = serverUpdateForField(field, value)
      if (Object.keys(serverUpdate).length === 0) return

      void updateServerRecord(recordId, serverUpdate)
        .then((serverRecord) => {
          ydoc.transact(() => upsertYDatabaseRecord(serverRecord))
        })
        .catch((error: unknown) => {
          console.warn('Failed to persist record field update', error)
        })
    },
    []
  )

  const handleCreateRecord = useCallback(async (data: CreateRecordData) => {
    const optimisticRecord = createOptimisticDatabaseRecord(data)

    ydoc.transact(() => {
      upsertYDatabaseRecord(optimisticRecord)
    })

    await createServerRecord({
      ...data,
      assignee: data.assignee ?? null,
      labels: data.labels ?? [],
      project: data.project ?? appKitConfig.records.defaultProject,
    })
      .then((serverRecord) => {
        ydoc.transact(() => {
          removeYDatabaseRecord(optimisticRecord.id)
          upsertYDatabaseRecord(serverRecord)
        })
      })
      .catch((error: unknown) => {
        console.warn('Failed to persist created record', error)
        ydoc.transact(() => {
          removeYDatabaseRecord(optimisticRecord.id)
        })
        throw error
      })
  }, [])

  const handleDeleteRecord = useCallback((recordId: string) => {
    void deleteServerRecord(recordId)
      .then(() => {
        ydoc.transact(() => {
          removeYDatabaseRecord(recordId)
        })
      })
      .catch((error: unknown) => {
        console.warn('Failed to persist record deletion', error)
      })
  }, [])

  const syncRecord = useCallback((record: DatabaseRecord) => {
    ydoc.transact(() => {
      upsertYDatabaseRecord(record)
    })
  }, [])

  const syncRecords = useCallback((serverRecords: DatabaseRecord[]) => {
    ydoc.transact(() => {
      reconcileYRecords(serverRecords)
    })
  }, [])

  return (
    <RecordsContext.Provider
      value={{
        records,
        handleMoveRecord,
        handleUpdateRecord,
        handleCreateRecord,
        handleDeleteRecord,
        syncRecord,
        syncRecords,
        recordCountByStatus,
      }}
    >
      {children}
    </RecordsContext.Provider>
  )
}

export function useRecords() {
  const ctx = useContext(RecordsContext)
  if (!ctx) throw new Error('useRecords must be used within RecordsProvider')
  return ctx
}

export const DatabaseRecordsProvider = RecordsProvider

export function useDatabaseRecords() {
  const {
    records,
    handleMoveRecord,
    handleUpdateRecord,
    handleCreateRecord,
    handleDeleteRecord,
    syncRecord,
    syncRecords,
    recordCountByStatus,
  } = useRecords()

  return {
    records,
    handleMoveRecord,
    handleUpdateRecord,
    handleCreateRecord,
    handleDeleteRecord,
    syncRecord,
    syncRecords,
    recordCountByStatus,
  }
}
