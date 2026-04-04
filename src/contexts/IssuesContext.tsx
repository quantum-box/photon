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
import { mockIssues, type Issue, type Status, type Priority } from '../data/mock'

export interface CreateIssueData {
  title: string
  status?: Status
  priority?: Priority
  assignee?: string | null
  description?: string
  labels?: string[]
  project?: string
}

interface IssuesContextValue {
  issues: Issue[]
  handleMoveIssue: (issueId: string, newStatus: Status) => void
  handleUpdateIssue: (issueId: string, field: keyof Issue, value: string) => void
  handleCreateIssue: (data: CreateIssueData) => void
  handleDeleteIssue: (issueId: string) => void
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

function seedMockData() {
  ydoc.transact(() => {
    for (const issue of mockIssues) {
      const ymap = new Y.Map<string>()
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
      issuesArray.push([ymap])
    }
  })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function IssuesProvider({ children }: { children: ReactNode }) {
  const { issues, ready } = useYjsIssues()

  // Seed mock data on very first load (empty doc)
  useEffect(() => {
    if (ready && issuesArray.length === 0) {
      seedMockData()
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
      const ymap = findYMap(issueId)
      if (!ymap) return
      ymap.set('status', newStatus)
      ymap.set('updatedAt', new Date().toISOString())
    })
  }, [])

  const handleUpdateIssue = useCallback(
    (issueId: string, field: keyof Issue, value: string) => {
      ydoc.transact(() => {
        const ymap = findYMap(issueId)
        if (!ymap) return
        if (field === 'labels') {
          // value is already a string from the caller; ensure it's valid JSON array
          ymap.set('labels', value)
        } else if (field === 'assignee') {
          ymap.set('assignee', value === '' ? '' : value)
        } else {
          ymap.set(field, value)
        }
        ymap.set('updatedAt', new Date().toISOString())
      })
    },
    []
  )

  const handleCreateIssue = useCallback((data: CreateIssueData) => {
    ydoc.transact(() => {
      let maxNum = 0
      for (let i = 0; i < issuesArray.length; i++) {
        const identifier = issuesArray.get(i).get('identifier') as string
        const num = parseInt(identifier.split('-')[1], 10)
        if (num > maxNum) maxNum = num
      }
      const ymap = new Y.Map<string>()
      ymap.set('id', `issue-${Date.now()}`)
      ymap.set('identifier', `PLT-${maxNum + 1}`)
      ymap.set('title', data.title)
      ymap.set('status', data.status ?? 'todo')
      ymap.set('priority', data.priority ?? 'none')
      ymap.set('assignee', data.assignee ?? '')
      ymap.set('labels', JSON.stringify(data.labels ?? []))
      ymap.set('project', data.project ?? 'Tachyon UI')
      ymap.set('createdAt', new Date().toISOString())
      ymap.set('updatedAt', new Date().toISOString())
      ymap.set('description', data.description ?? '')
      issuesArray.push([ymap])
    })
  }, [])

  const handleDeleteIssue = useCallback((issueId: string) => {
    ydoc.transact(() => {
      for (let i = 0; i < issuesArray.length; i++) {
        if (issuesArray.get(i).get('id') === issueId) {
          issuesArray.delete(i, 1)
          break
        }
      }
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
