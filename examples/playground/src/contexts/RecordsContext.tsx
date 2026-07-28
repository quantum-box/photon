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
// Provider
//
// The engine is the only read path. Writes go through the record API, which
// applies them to the engine optimistically; the live query below observes the
// same store, so every mutation is visible to React before it is durable, let
// alone acknowledged. The PhotonProvider this hook needs is mounted above the
// app in main.tsx, before the first paint.
// ---------------------------------------------------------------------------

export function RecordsProvider({ children }: { children: ReactNode }) {
  const query = useLiveQuery<DatabaseRecord>({
    collection: 'records',
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
  })
  const records = useMemo(() => query.data.map((record) => record.value), [query.data])

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

  return (
    <RecordsContext.Provider
      value={{
        records,
        handleMoveRecord,
        handleUpdateRecord,
        handleCreateRecord,
        handleDeleteRecord,
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
  return useRecords()
}
