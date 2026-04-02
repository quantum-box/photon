/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react'
import { mockIssues, type Issue, type Status } from '../data/mock'

interface IssuesContextValue {
  issues: Issue[]
  handleMoveIssue: (issueId: string, newStatus: Status) => void
  handleUpdateIssue: (issueId: string, field: keyof Issue, value: string) => void
  handleCreateIssue: (title: string) => void
  issueCountByStatus: Record<string, number>
}

const IssuesContext = createContext<IssuesContextValue | null>(null)

export function IssuesProvider({ children }: { children: ReactNode }) {
  const [issues, setIssues] = useState<Issue[]>(mockIssues)

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
    setIssues((prev) =>
      prev.map((i) => (i.id === issueId ? { ...i, status: newStatus } : i))
    )
  }, [])

  const handleUpdateIssue = useCallback(
    (issueId: string, field: keyof Issue, value: string) => {
      const resolved = field === 'assignee' && value === '' ? null : value
      setIssues((prev) =>
        prev.map((i) => (i.id === issueId ? { ...i, [field]: resolved } : i))
      )
    },
    []
  )

  const handleCreateIssue = useCallback((title: string) => {
    setIssues((prev) => {
      const maxNum = prev.reduce((max, i) => {
        const num = parseInt(i.identifier.split('-')[1], 10)
        return num > max ? num : max
      }, 0)
      const newIssue: Issue = {
        id: `issue-${Date.now()}`,
        identifier: `PLT-${maxNum + 1}`,
        title,
        status: 'todo',
        priority: 'none',
        assignee: null,
        labels: [],
        project: 'Tachyon UI',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: '',
      }
      return [...prev, newIssue]
    })
  }, [])

  return (
    <IssuesContext.Provider
      value={{
        issues,
        handleMoveIssue,
        handleUpdateIssue,
        handleCreateIssue,
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
