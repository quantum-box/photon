import { statusConfig, type Status } from '../data/mock'

interface SidebarProps {
  currentView: 'table' | 'kanban'
  onViewChange: (view: 'table' | 'kanban') => void
  statusFilter: Status | null
  onStatusFilter: (status: Status | null) => void
  issueCountByStatus: Record<Status, number>
}

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

export function Sidebar({
  currentView,
  onViewChange,
  statusFilter,
  onStatusFilter,
  issueCountByStatus,
}: SidebarProps) {
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
          <button
            className="flex-1 px-2 py-1 rounded text-xs font-medium transition-colors"
            style={{
              background:
                currentView === 'table' ? 'var(--accent)' : 'transparent',
              color:
                currentView === 'table'
                  ? '#fff'
                  : 'var(--text-secondary)',
            }}
            onClick={() => onViewChange('table')}
          >
            Table
          </button>
          <button
            className="flex-1 px-2 py-1 rounded text-xs font-medium transition-colors"
            style={{
              background:
                currentView === 'kanban' ? 'var(--accent)' : 'transparent',
              color:
                currentView === 'kanban'
                  ? '#fff'
                  : 'var(--text-secondary)',
            }}
            onClick={() => onViewChange('kanban')}
          >
            Board
          </button>
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
            color: statusFilter === null ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: statusFilter === null ? 'var(--bg-hover)' : 'transparent',
          }}
          onClick={() => onStatusFilter(null)}
        >
          <span>All</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {Object.values(issueCountByStatus).reduce((a, b) => a + b, 0)}
          </span>
        </button>
        {(Object.entries(statusConfig) as [Status, typeof statusConfig[Status]][]).map(
          ([key, config]) => (
            <button
              key={key}
              className="flex items-center justify-between w-full px-2 py-1.5 rounded text-sm transition-colors"
              style={{
                color: statusFilter === key ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: statusFilter === key ? 'var(--bg-hover)' : 'transparent',
              }}
              onClick={() => onStatusFilter(statusFilter === key ? null : key)}
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
          )
        )}
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
