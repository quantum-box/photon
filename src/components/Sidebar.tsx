import { useNavigate, useRouterState, Link } from '@tanstack/react-router'
import { statusConfig, type Status } from '../data/mock'
import { useIssues } from '../contexts/IssuesContext'

const navItems = [
  { id: 'my-issues', label: 'My Issues', icon: '👤' },
  { id: 'all-issues', label: 'All Issues', icon: '📋' },
  { id: 'active', label: 'Active', icon: '⚡' },
]

const teamItems = [
  { id: 'tachyon-core', label: 'Tachyon Core' },
  { id: 'tachyon-ui', label: 'Tachyon UI' },
  { id: 'api-gateway', label: 'API Gateway' },
  { id: 'auth-service', label: 'Auth Service' },
]

const views = [
  { id: 'table' as const, label: 'Table', to: '/issues' as const },
  { id: 'kanban' as const, label: 'Board', to: '/kanban' as const },
  { id: 'chat' as const, label: 'Chat', to: '/chat' as const },
] as const

export function Sidebar() {
  const { issueCountByStatus } = useIssues()
  const navigate = useNavigate()

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.search }) as {
    status?: Status
  }
  const statusFilter = search.status ?? null

  const currentView = pathname.startsWith('/kanban')
    ? 'kanban'
    : pathname.startsWith('/chat')
      ? 'chat'
      : 'table'

  const handleStatusFilter = (status: Status | null) => {
    const to = currentView === 'kanban' ? '/kanban' : '/issues'
    void navigate({
      to,
      search: status ? { status } : {},
    })
  }

  return (
    <aside
      className="flex flex-col h-full border-r"
      style={{
        width: 'var(--sidebar-width)',
        minWidth: 'var(--sidebar-width)',
        background: 'var(--bg-sidebar)',
        borderColor: 'var(--border-color)',
      }}
    >
      {/* Workspace */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div
          className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
          style={{ background: 'var(--accent)' }}
        >
          T
        </div>
        <span className="text-sm font-semibold">Tachyon</span>
      </div>

      {/* Navigation */}
      <div className="px-2 py-3">
        {navItems.map((item) => (
          <button
            key={item.id}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-left transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = 'var(--bg-hover)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* View Toggle */}
      <div
        className="px-2 py-2 border-t border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div className="px-2 mb-1">
          <span
            className="text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            View
          </span>
        </div>
        <div className="flex gap-1 px-1">
          {views.map((view) => (
            <Link
              key={view.id}
              to={view.to}
              search={
                view.id !== 'chat' && statusFilter
                  ? { status: statusFilter }
                  : {}
              }
              className="flex-1 px-2 py-1 rounded text-xs font-medium transition-colors text-center block"
              style={{
                background:
                  currentView === view.id ? 'var(--accent)' : 'transparent',
                color:
                  currentView === view.id ? '#fff' : 'var(--text-secondary)',
                textDecoration: 'none',
              }}
            >
              {view.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Status Filter */}
      <div className="px-2 py-3 flex-1 overflow-y-auto">
        <div className="px-2 mb-1">
          <span
            className="text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            Status
          </span>
        </div>
        <button
          className="flex items-center justify-between w-full px-2 py-1.5 rounded text-sm transition-colors"
          style={{
            color:
              statusFilter === null
                ? 'var(--text-primary)'
                : 'var(--text-secondary)',
            background:
              statusFilter === null ? 'var(--bg-hover)' : 'transparent',
          }}
          onClick={() => handleStatusFilter(null)}
        >
          <span>All</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {Object.values(issueCountByStatus).reduce(
              (a, b) => a + b,
              0
            )}
          </span>
        </button>
        {(
          Object.entries(statusConfig) as [
            Status,
            (typeof statusConfig)[Status],
          ][]
        ).map(([key, config]) => (
          <button
            key={key}
            className="flex items-center justify-between w-full px-2 py-1.5 rounded text-sm transition-colors"
            style={{
              color:
                statusFilter === key
                  ? 'var(--text-primary)'
                  : 'var(--text-secondary)',
              background:
                statusFilter === key ? 'var(--bg-hover)' : 'transparent',
            }}
            onClick={() =>
              handleStatusFilter(statusFilter === key ? null : key)
            }
            onMouseEnter={(e) => {
              if (statusFilter !== key)
                e.currentTarget.style.background = 'var(--bg-hover)'
            }}
            onMouseLeave={(e) => {
              if (statusFilter !== key)
                e.currentTarget.style.background = ''
            }}
          >
            <span className="flex items-center gap-2">
              <span style={{ color: config.color }}>{config.icon}</span>
              <span>{config.label}</span>
            </span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {issueCountByStatus[key] || 0}
            </span>
          </button>
        ))}
      </div>

      {/* Teams */}
      <div
        className="px-2 py-3 border-t"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div className="px-2 mb-1">
          <span
            className="text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            Projects
          </span>
        </div>
        {teamItems.map((item) => (
          <button
            key={item.id}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = 'var(--bg-hover)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
