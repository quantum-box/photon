import { appKitConfig } from '../app/kitConfig.js'
import { mockIssues, type Issue, type Priority, type Status } from '../data/mock'
import {
  deleteClientEngineRecord,
  getClientEngineRecord,
  listClientEngineRecords,
  patchClientEngineRecord,
  upsertClientEngineRecord,
} from './photonEngine/client'

export interface ServerIssue {
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

export interface ServerIssueListResponse {
  issues: ServerIssue[]
  total: number
}

export interface ServerCreateIssueData {
  title: string
  status?: Status
  priority?: Priority
  assignee?: string | null
  description?: string
  labels?: string[]
  project?: string
}

export interface ServerUpdateIssueData {
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
const defaultIssueSeedId = 'default-issues-v1'

let seedDefaultIssuesPromise: Promise<void> | null = null

export class IssueApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'IssueApiError'
    this.status = status
  }
}

function normalizeStatus(value: string | undefined): Status {
  return statuses.includes(value as Status) ? (value as Status) : 'backlog'
}

function normalizePriority(value: string | undefined): Priority {
  return priorities.includes(value as Priority) ? (value as Priority) : 'none'
}

function normalizeLabels(value: ServerIssue['labels']): string[] {
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

export function toIssue(serverIssue: ServerIssue): Issue {
  return {
    id: serverIssue.id,
    identifier: serverIssue.identifier ?? serverIssue.id,
    title: serverIssue.title,
    status: normalizeStatus(serverIssue.status),
    priority: normalizePriority(serverIssue.priority),
    assignee: serverIssue.assignee || null,
    labels: normalizeLabels(serverIssue.labels),
    project: serverIssue.project ?? appKitConfig.issues.defaultProject,
    createdAt: serverIssue.created_at ?? new Date().toISOString(),
    updatedAt: serverIssue.updated_at ?? serverIssue.created_at ?? new Date().toISOString(),
    description: serverIssue.description ?? '',
  }
}

function withoutUndefined<T extends object>(payload: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

function randomIssueId() {
  return globalThis.crypto?.randomUUID?.() ?? `issue-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function nextIdentifier(issues: Issue[]) {
  const prefix = appKitConfig.issues.identifierPrefix
  const maxNumber = issues.reduce((max, issue) => {
    const match = issue.identifier.match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(max, Number(match[1])) : max
  }, 100)
  return `${prefix}-${maxNumber + 1}`
}

async function ensureDefaultIssueRecords() {
  seedDefaultIssuesPromise ??= (async () => {
    const existingSeed = await getClientEngineRecord(seedCollection, defaultIssueSeedId, {
      includeDeleted: true,
    })
    if (existingSeed) return

    for (const issue of mockIssues) {
      await upsertClientEngineRecord('issues', issue.id, issue)
    }
    await upsertClientEngineRecord(seedCollection, defaultIssueSeedId, {
      seededAt: new Date().toISOString(),
      count: mockIssues.length,
    })
  })().catch((error: unknown) => {
    seedDefaultIssuesPromise = null
    throw error
  })

  return seedDefaultIssuesPromise
}

export async function fetchServerIssues(): Promise<Issue[]> {
  let records = await listClientEngineRecords<Issue>('issues')
  if (import.meta.env.MODE === 'test') {
    return records.map((record) => record.value)
  }
  if (records.length === 0) {
    await ensureDefaultIssueRecords()
    records = await listClientEngineRecords<Issue>('issues')
  }
  return records.map((record) => record.value)
}

export async function createServerIssue(data: ServerCreateIssueData): Promise<Issue> {
  const issues = (await listClientEngineRecords<Issue>('issues')).map((record) => record.value)
  const now = new Date().toISOString()
  const issue: Issue = {
    id: randomIssueId(),
    identifier: nextIdentifier(issues),
    title: data.title,
    status: data.status ?? 'todo',
    priority: data.priority ?? 'none',
    assignee: data.assignee ?? null,
    labels: data.labels ?? [],
    project: data.project ?? appKitConfig.issues.defaultProject,
    createdAt: now,
    updatedAt: now,
    description: data.description ?? '',
  }
  const record = await upsertClientEngineRecord('issues', issue.id, issue)
  return record.value
}

export async function updateServerIssue(
  issueId: string,
  data: ServerUpdateIssueData
): Promise<Issue> {
  const existing = (await listClientEngineRecords<Issue>('issues'))
    .find((record) => record.recordId === issueId)?.value
  if (!existing) {
    throw new IssueApiError('Issue not found', 404)
  }

  const issue: Issue = {
    ...existing,
    ...withoutUndefined(data),
    assignee: data.assignee === undefined ? existing.assignee : data.assignee,
    labels: data.labels ?? existing.labels,
    updatedAt: new Date().toISOString(),
  }
  const record = await patchClientEngineRecord<Issue>('issues', issueId, issue)
  if (!record) throw new IssueApiError('Issue not found', 404)
  return record.value
}

export async function deleteServerIssue(issueId: string): Promise<void> {
  await deleteClientEngineRecord('issues', issueId)
}
