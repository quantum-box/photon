import { useState, useMemo, useCallback } from 'react'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { KanbanView } from './components/KanbanView'
import { DetailPanel } from './components/DetailPanel'
import { ChatView } from './components/chat/ChatView'
import { mockIssues, type Issue, type Status } from './data/mock'

function App() {
  const [currentView, setCurrentView] = useState<'table' | 'kanban' | 'chat'>('table')
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  const [issues, setIssues] = useState<Issue[]>(mockIssues)

  const filteredIssues = useMemo(
    () => (statusFilter ? issues.filter((i) => i.status === statusFilter) : issues),
    [issues, statusFilter]
  )

  const issueCountByStatus = useMemo(
    () =>
      issues.reduce(
        (acc, issue) => {
          acc[issue.status] = (acc[issue.status] || 0) + 1
          return acc
        },
        {} as Record<Status, number>
      ),
    [issues]
  )

  const handleSelectIssue = useCallback((issue: Issue) => {
    setSelectedIssue((prev) => (prev?.id === issue.id ? null : issue))
  }, [])

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
      // Also update selected issue if it's the one being edited
      setSelectedIssue((prev) =>
        prev?.id === issueId ? { ...prev, [field]: resolved } : prev
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
    <div className="flex h-full">
      <Sidebar
        currentView={currentView}
        onViewChange={setCurrentView}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        issueCountByStatus={issueCountByStatus}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 p-2">
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: 'var(--border-color)' }}
        >
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold">Issues</h1>
            {statusFilter && (
              <span
                className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1"
                style={{
                  background: 'var(--bg-hover)',
                  color: 'var(--text-secondary)',
                }}
              >
                {statusFilter}
                <button
                  onClick={() => setStatusFilter(null)}
                  className="ml-1 hover:opacity-75"
                  style={{ color: 'var(--text-muted)' }}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 rounded text-xs font-medium"
              style={{
                background: 'var(--accent)',
                color: '#fff',
              }}
            >
              + New Issue
            </button>
          </div>
        </div>

        {/* View */}
        <div className="flex-1 min-h-0 mt-1">
          {currentView === 'chat' ? (
            <ChatView />
          ) : currentView === 'table' ? (
            <TableView
              issues={filteredIssues}
              selectedIssueId={selectedIssue?.id ?? null}
              onSelectIssue={handleSelectIssue}
              onUpdateIssue={handleUpdateIssue}
              onCreateIssue={handleCreateIssue}
            />
          ) : (
            <KanbanView
              issues={filteredIssues}
              selectedIssueId={selectedIssue?.id ?? null}
              onSelectIssue={handleSelectIssue}
              onMoveIssue={handleMoveIssue}
            />
          )}
        </div>
      </div>

      {/* Detail Panel */}
      {selectedIssue && (
        <DetailPanel
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}
    </div>
  )
}

export default App
