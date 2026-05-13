import { appKitConfig } from '../app/kitConfig.js'
import type { Issue, Priority, Status } from '../data/mock'

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

export class IssueApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'IssueApiError'
    this.status = status
  }
}

function buildApiUrl(path: string) {
  const baseUrl = appKitConfig.server.apiBaseUrl?.replace(/\/$/, '') ?? ''
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new IssueApiError(message || response.statusText, response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
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

export async function fetchServerIssues(): Promise<Issue[]> {
  const response = await request<ServerIssueListResponse>(appKitConfig.server.issuesPath)
  return response.issues.map(toIssue)
}

export async function createServerIssue(data: ServerCreateIssueData): Promise<Issue> {
  const issue = await request<ServerIssue>(appKitConfig.server.issuesPath, {
    method: 'POST',
    body: JSON.stringify(withoutUndefined(data)),
  })
  return toIssue(issue)
}

export async function updateServerIssue(
  issueId: string,
  data: ServerUpdateIssueData
): Promise<Issue> {
  const issue = await request<ServerIssue>(
    `${appKitConfig.server.issuesPath}/${encodeURIComponent(issueId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(withoutUndefined(data)),
    }
  )
  return toIssue(issue)
}

export async function deleteServerIssue(issueId: string): Promise<void> {
  await request<void>(`${appKitConfig.server.issuesPath}/${encodeURIComponent(issueId)}`, {
    method: 'DELETE',
  })
}
