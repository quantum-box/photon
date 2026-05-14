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
import { ydoc, issuesArray } from '../lib/yjs/yjsProvider'
import { useYjsIssues } from '../lib/yjs/useYjsIssues'
import {
  createServerIssue,
  deleteServerIssue,
  fetchServerIssues,
  updateServerIssue,
  type ServerUpdateIssueData,
} from '../lib/issuesApi'
import { mockIssues, type Issue, type Status, type Priority } from '../data/mock'
import { appKitConfig } from '../app/kitConfig'

export interface CreateIssueData {
  title: string
  status?: Status
  priority?: Priority
  assignee?: string | null
  description?: string
  labels?: string[]
  project?: string
}

export type CreateRecordData = CreateIssueData

interface IssuesContextValue {
  issues: Issue[]
  handleMoveIssue: (issueId: string, newStatus: Status) => void
  handleUpdateIssue: (issueId: string, field: keyof Issue, value: string) => void
  handleCreateIssue: (data: CreateIssueData) => void
  handleDeleteIssue: (issueId: string) => void
  syncIssue: (issue: Issue) => void
  syncIssues: (issues: Issue[]) => void
  issueCountByStatus: Record<string, number>
}

const IssuesContext = createContext<IssuesContextValue | null>(null)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findYMap(id: string): Y.Map<string> | null {
  for (let i = 0; i < issuesArray.length; i++) {
    const ymap = issuesArray.get(i)
    if (ymap.get('id') === id) return ymap
  }
  return null
}

function removeDuplicateYIssues(id: string, keep: Y.Map<string>) {
  for (let i = issuesArray.length - 1; i >= 0; i--) {
    const ymap = issuesArray.get(i)
    if (ymap !== keep && ymap.get('id') === id) {
      issuesArray.delete(i, 1)
    }
  }
}

function writeIssueToYMap(ymap: Y.Map<string>, issue: Issue) {
  ymap.set('id', issue.id)
  ymap.set('identifier', issue.identifier)
  ymap.set('title', issue.title)
  ymap.set('status', issue.status)
  ymap.set('priority', issue.priority)
  ymap.set('assignee', issue.assignee ?? '')
  ymap.set('labels', JSON.stringify(issue.labels))
  ymap.set('project', issue.project)
  ymap.set('createdAt', issue.createdAt)
  ymap.set('updatedAt', issue.updatedAt)
  ymap.set('description', issue.description)
}

function upsertYIssue(issue: Issue) {
  const existing = findYMap(issue.id)
  if (existing) {
    writeIssueToYMap(existing, issue)
    removeDuplicateYIssues(issue.id, existing)
    return
  }

  const ymap = new Y.Map<string>()
  writeIssueToYMap(ymap, issue)
  issuesArray.push([ymap])
}

function removeYIssue(issueId: string) {
  for (let i = 0; i < issuesArray.length; i++) {
    if (issuesArray.get(i).get('id') === issueId) {
      issuesArray.delete(i, 1)
      return
    }
  }
}

function reconcileYIssues(serverIssues: Issue[]) {
  const serverIds = new Set(serverIssues.map((issue) => issue.id))

  for (const issue of serverIssues) {
    upsertYIssue(issue)
  }

  for (let i = issuesArray.length - 1; i >= 0; i--) {
    const id = issuesArray.get(i).get('id') as string | undefined
    if (!id || !serverIds.has(id)) {
      issuesArray.delete(i, 1)
    }
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
  field: keyof Issue,
  value: string
): ServerUpdateIssueData {
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

function applyLocalFieldUpdate(issueId: string, field: keyof Issue, value: string) {
  const ymap = findYMap(issueId)
  if (!ymap) return

  if (field === 'labels') {
    ymap.set('labels', JSON.stringify(parseLabels(value)))
  } else if (field === 'assignee') {
    ymap.set('assignee', value)
  } else {
    ymap.set(field, value)
  }
  ymap.set('updatedAt', new Date().toISOString())
}

function getNextLocalIdentifier() {
  let maxNum = 0
  for (let i = 0; i < issuesArray.length; i++) {
    const identifier = issuesArray.get(i).get('identifier') as string | undefined
    const num = parseInt(identifier?.split('-')[1] ?? '', 10)
    if (num > maxNum) maxNum = num
  }
  return `${appKitConfig.issues.identifierPrefix}-${maxNum + 1}`
}

function createLocalIssueId() {
  return `local-${
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`
}

function createOptimisticIssue(data: CreateIssueData): Issue {
  const now = new Date().toISOString()

  return {
    id: createLocalIssueId(),
    identifier: getNextLocalIdentifier(),
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
}

function seedMockData() {
  ydoc.transact(() => {
    for (const issue of mockIssues) {
      upsertYIssue(issue)
    }
  })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function IssuesProvider({ children }: { children: ReactNode }) {
  const { issues, ready } = useYjsIssues()

  // Hydrate the Yjs projection from the canonical issue API. If the app server
  // is unavailable in local/offline use, keep the existing local-first fallback.
  useEffect(() => {
    if (!ready) return

    let cancelled = false

    fetchServerIssues()
      .then((serverIssues) => {
        if (cancelled) return
        ydoc.transact(() => {
          reconcileYIssues(serverIssues)
        })
      })
      .catch((error: unknown) => {
        console.warn('Failed to hydrate issues from the application server', error)
        if (!cancelled && issuesArray.length === 0) {
          seedMockData()
        }
      })

    return () => {
      cancelled = true
    }
  }, [ready])

  const issueCountByStatus = useMemo(
    () =>
      issues.reduce(
        (acc, issue) => {
          acc[issue.status] = (acc[issue.status] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ),
    [issues]
  )

  const handleMoveIssue = useCallback((issueId: string, newStatus: Status) => {
    ydoc.transact(() => {
      applyLocalFieldUpdate(issueId, 'status', newStatus)
    })
    void updateServerIssue(issueId, { status: newStatus })
      .then((serverIssue) => {
        ydoc.transact(() => upsertYIssue(serverIssue))
      })
      .catch((error: unknown) => {
        console.warn('Failed to persist issue status update', error)
      })
  }, [])

  const handleUpdateIssue = useCallback(
    (issueId: string, field: keyof Issue, value: string) => {
      ydoc.transact(() => {
        applyLocalFieldUpdate(issueId, field, value)
      })

      const serverUpdate = serverUpdateForField(field, value)
      if (Object.keys(serverUpdate).length === 0) return

      void updateServerIssue(issueId, serverUpdate)
        .then((serverIssue) => {
          ydoc.transact(() => upsertYIssue(serverIssue))
        })
        .catch((error: unknown) => {
          console.warn('Failed to persist issue field update', error)
        })
    },
    []
  )

  const handleCreateIssue = useCallback((data: CreateIssueData) => {
    const optimisticIssue = createOptimisticIssue(data)

    ydoc.transact(() => {
      upsertYIssue(optimisticIssue)
    })

    void createServerIssue({
      ...data,
      assignee: data.assignee ?? null,
      labels: data.labels ?? [],
      project: data.project ?? appKitConfig.issues.defaultProject,
    })
      .then((serverIssue) => {
        ydoc.transact(() => {
          removeYIssue(optimisticIssue.id)
          upsertYIssue(serverIssue)
        })
      })
      .catch((error: unknown) => {
        console.warn('Failed to persist created issue', error)
      })
  }, [])

  const handleDeleteIssue = useCallback((issueId: string) => {
    ydoc.transact(() => {
      removeYIssue(issueId)
    })
    void deleteServerIssue(issueId).catch((error: unknown) => {
      console.warn('Failed to persist issue deletion', error)
    })
  }, [])

  const syncIssue = useCallback((issue: Issue) => {
    ydoc.transact(() => {
      upsertYIssue(issue)
    })
  }, [])

  const syncIssues = useCallback((serverIssues: Issue[]) => {
    ydoc.transact(() => {
      reconcileYIssues(serverIssues)
    })
  }, [])

  return (
    <IssuesContext.Provider
      value={{
        issues,
        handleMoveIssue,
        handleUpdateIssue,
        handleCreateIssue,
        handleDeleteIssue,
        syncIssue,
        syncIssues,
        issueCountByStatus,
      }}
    >
      {children}
    </IssuesContext.Provider>
  )
}

export function useIssues() {
  const ctx = useContext(IssuesContext)
  if (!ctx) throw new Error('useIssues must be used within IssuesProvider')
  return ctx
}

export const DatabaseRecordsProvider = IssuesProvider

export function useDatabaseRecords() {
  const {
    issues,
    handleMoveIssue,
    handleUpdateIssue,
    handleCreateIssue,
    handleDeleteIssue,
    syncIssue,
    syncIssues,
    issueCountByStatus,
  } = useIssues()

  return {
    records: issues,
    handleMoveRecord: handleMoveIssue,
    handleUpdateRecord: handleUpdateIssue,
    handleCreateRecord: handleCreateIssue,
    handleDeleteRecord: handleDeleteIssue,
    syncRecord: syncIssue,
    syncRecords: syncIssues,
    recordCountByStatus: issueCountByStatus,
  }
}
