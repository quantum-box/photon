/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react'
import { useLiveQuery } from '@quantum-box/photon-react'
import {
  createServerRecord,
  deleteServerRecord,
  updateServerRecord,
  type ServerUpdateRecordData,
} from '../lib/recordsApi'
import type { DatabaseRecord, Status, Priority } from '../data/mock'
import { appKitConfig } from '../app/kitConfig'

export const RECORDS_COLLECTION = 'records'

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
  handleMoveRecord: (recordId: string, newStatus: Status) => void
  handleUpdateRecord: (recordId: string, field: keyof DatabaseRecord, value: string) => void
  handleCreateRecord: (data: CreateRecordData) => Promise<void>
  handleDeleteRecord: (recordId: string) => void
  recordCountByStatus: Record<string, number>
}

const RecordsContext = createContext<RecordsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Live records
//
// The engine is the only read path. Components that need the full record list
// (row ordering, filtering, search) subscribe here on their own; cells that
// need a single value subscribe with useRecordField instead. The
// PhotonProvider this hook needs is mounted above the app in main.tsx, before
// the first paint.
// ---------------------------------------------------------------------------

export function useLiveRecords(): DatabaseRecord[] {
  const query = useLiveQuery<DatabaseRecord>({
    collection: RECORDS_COLLECTION,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
  })
  return useMemo(() => query.data.map((record) => record.value), [query.data])
}

// ---------------------------------------------------------------------------
// Provider
//
// The context carries only the write handlers and the status counts. Writes go
// through the record API, which applies them to the engine optimistically; the
// live queries observe the same store, so every mutation is visible to React
// before it is durable, let alone acknowledged.
// ---------------------------------------------------------------------------

export function RecordsProvider({ children }: { children: ReactNode }) {
  const records = useLiveRecords()

  // Serialize the counts into a key so the map keeps its identity across
  // deltas that don't move a record between statuses — otherwise every cell
  // edit would ripple through all context consumers.
  const recordCountKey = useMemo(() => {
    const counts = new Map<string, number>()
    for (const record of records) {
      counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
    }
    return JSON.stringify([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }, [records])
  const recordCountByStatus = useMemo(
    () => Object.fromEntries(JSON.parse(recordCountKey) as [string, number][]),
    [recordCountKey]
  )

  const handleMoveRecord = useCallback((recordId: string, newStatus: Status) => {
    void updateServerRecord(recordId, { status: newStatus }).catch((error: unknown) => {
      console.warn('Failed to persist record status update', error)
    })
  }, [])

  const handleUpdateRecord = useCallback(
    (recordId: string, field: keyof DatabaseRecord, value: string) => {
      const serverUpdate = serverUpdateForField(field, value)
      if (Object.keys(serverUpdate).length === 0) return

      void updateServerRecord(recordId, serverUpdate).catch((error: unknown) => {
        console.warn('Failed to persist record field update', error)
      })
    },
    []
  )

  const handleCreateRecord = useCallback(async (data: CreateRecordData) => {
    await createServerRecord({
      ...data,
      assignee: data.assignee ?? null,
      labels: data.labels ?? [],
      project: data.project ?? appKitConfig.records.defaultProject,
    })
  }, [])

  const handleDeleteRecord = useCallback((recordId: string) => {
    void deleteServerRecord(recordId).catch((error: unknown) => {
      console.warn('Failed to persist record deletion', error)
    })
  }, [])

  const value = useMemo(
    () => ({
      handleMoveRecord,
      handleUpdateRecord,
      handleCreateRecord,
      handleDeleteRecord,
      recordCountByStatus,
    }),
    [
      handleCreateRecord,
      handleDeleteRecord,
      handleMoveRecord,
      handleUpdateRecord,
      recordCountByStatus,
    ]
  )

  return <RecordsContext.Provider value={value}>{children}</RecordsContext.Provider>
}

export function useRecords() {
  const ctx = useContext(RecordsContext)
  if (!ctx) throw new Error('useRecords must be used within RecordsProvider')
  return ctx
}

export const DatabaseRecordsProvider = RecordsProvider

export function useDatabaseRecords() {
  return useRecords()
}
