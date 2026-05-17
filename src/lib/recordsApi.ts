import { appKitConfig } from '../app/kitConfig.js'
import { mockDatabaseRecords, type DatabaseRecord, type Priority, type Status } from '../data/mock'
import {
  deleteClientEngineRecord,
  getClientEngineRecord,
  listClientEngineRecords,
  patchClientEngineRecord,
  upsertClientEngineRecord,
} from './photonEngine/client'

export interface ServerRecord {
  id: string
  identifier?: string
  title: string
  description?: string
  status?: string
  priority?: string
  assignee?: string | null
  labels?: string[] | string | null
  project?: string
  created_at?: string
  updated_at?: string
}

export interface ServerRecordListResponse {
  records: ServerRecord[]
  total: number
}

export interface ServerCreateRecordData {
  title: string
  status?: Status
  priority?: Priority
  assignee?: string | null
  description?: string
  labels?: string[]
  project?: string
}

export interface ServerUpdateRecordData {
  title?: string
  status?: Status
  priority?: Priority
  assignee?: string | null
  description?: string
  labels?: string[]
  project?: string
}

const statuses: Status[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]
const priorities: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const seedCollection = 'engine_seed'
const defaultRecordSeedId = 'default-records-v1'

let seedDefaultRecordsPromise: Promise<void> | null = null

export class RecordApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RecordApiError'
    this.status = status
  }
}

function normalizeStatus(value: string | undefined): Status {
  return statuses.includes(value as Status) ? (value as Status) : 'backlog'
}

function normalizePriority(value: string | undefined): Priority {
  return priorities.includes(value as Priority) ? (value as Priority) : 'none'
}

function normalizeLabels(value: ServerRecord['labels']): string[] {
  if (Array.isArray(value)) {
    return value.filter((label): label is string => typeof label === 'string')
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((label): label is string => typeof label === 'string')
      }
    } catch {
      return []
    }
  }

  return []
}

export function toRecord(serverRecord: ServerRecord): DatabaseRecord {
  return {
    id: serverRecord.id,
    identifier: serverRecord.identifier ?? serverRecord.id,
    title: serverRecord.title,
    status: normalizeStatus(serverRecord.status),
    priority: normalizePriority(serverRecord.priority),
    assignee: serverRecord.assignee || null,
    labels: normalizeLabels(serverRecord.labels),
    project: serverRecord.project ?? appKitConfig.records.defaultProject,
    createdAt: serverRecord.created_at ?? new Date().toISOString(),
    updatedAt: serverRecord.updated_at ?? serverRecord.created_at ?? new Date().toISOString(),
    description: serverRecord.description ?? '',
  }
}

function withoutUndefined<T extends object>(payload: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

function randomRecordId() {
  return globalThis.crypto?.randomUUID?.() ?? `record-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function nextIdentifier(records: DatabaseRecord[]) {
  const prefix = appKitConfig.records.identifierPrefix
  const maxNumber = records.reduce((max, record) => {
    const match = record.identifier?.match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(max, Number(match[1])) : max
  }, 100)
  return `${prefix}-${maxNumber + 1}`
}

async function ensureDefaultRecordRecords() {
  seedDefaultRecordsPromise ??= (async () => {
    const existingSeed = await getClientEngineRecord(seedCollection, defaultRecordSeedId, {
      includeDeleted: true,
    })
    if (existingSeed) return

    for (const record of mockDatabaseRecords) {
      await upsertClientEngineRecord('records', record.id, record)
    }
    await upsertClientEngineRecord(seedCollection, defaultRecordSeedId, {
      seededAt: new Date().toISOString(),
      count: mockDatabaseRecords.length,
    })
  })().catch((error: unknown) => {
    seedDefaultRecordsPromise = null
    throw error
  })

  return seedDefaultRecordsPromise
}

export async function fetchServerRecords(): Promise<DatabaseRecord[]> {
  let records = await listClientEngineRecords<DatabaseRecord>('records')
  if (import.meta.env.MODE === 'test') {
    return records.map((record) => record.value)
  }
  if (records.length === 0) {
    await ensureDefaultRecordRecords()
    records = await listClientEngineRecords<DatabaseRecord>('records')
  }
  return records.map((record) => record.value)
}

export async function createServerRecord(data: ServerCreateRecordData): Promise<DatabaseRecord> {
  const records = (await listClientEngineRecords<DatabaseRecord>('records')).map((record) => record.value)
  const now = new Date().toISOString()
  const record: DatabaseRecord = {
    id: randomRecordId(),
    identifier: nextIdentifier(records),
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
  const storedRecord = await upsertClientEngineRecord('records', record.id, record)
  return storedRecord.value
}

export async function updateServerRecord(
  recordId: string,
  data: ServerUpdateRecordData
): Promise<DatabaseRecord> {
  const existing = (await listClientEngineRecords<DatabaseRecord>('records'))
    .find((record) => record.recordId === recordId)?.value
  if (!existing) {
    throw new RecordApiError('Record not found', 404)
  }

  const record: DatabaseRecord = {
    ...existing,
    ...withoutUndefined(data),
    assignee: data.assignee === undefined ? existing.assignee : data.assignee,
    labels: data.labels ?? existing.labels,
    updatedAt: new Date().toISOString(),
  }
  const storedRecord = await patchClientEngineRecord<DatabaseRecord>('records', recordId, record)
  if (!storedRecord) throw new RecordApiError('Record not found', 404)
  return storedRecord.value
}

export async function deleteServerRecord(recordId: string): Promise<void> {
  await deleteClientEngineRecord('records', recordId)
}
