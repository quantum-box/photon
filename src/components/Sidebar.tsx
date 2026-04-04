import { useNavigate, useRouterState, Link } from '@tanstack/react-router'
import { statusConfig, type Status } from '../data/mock'
import { useIssues } from '../contexts/IssuesContext'
import { useTheme } from '../contexts/ThemeContext'
import type { ThemeMode } from '../contexts/ThemeContext'
import { useConnectionStatus } from '../lib/yjs/useYjsIssues'

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

const SunIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
)

const MoonIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

const MonitorIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
)

const themeOptions: { mode: ThemeMode; icon: React.ReactNode; label: string }[] = [
  { mode: 'light', icon: SunIcon, label: 'Light' },
  { mode: 'dark', icon: MoonIcon, label: 'Dark' },
  { mode: 'system', icon: MonitorIcon, label: 'System' },
]

function ThemeToggle() {
  const { mode, setMode } = useTheme()

  return (
    <div className="px-2 py-3 border-t border-border">
      <div className="flex gap-1 px-1">
        {themeOptions.map((opt) => (
          <button
            key={opt.mode}
            onClick={() => setMode(opt.mode)}
            className={`flex-1 flex flex-col items-center gap-1 px-1 py-1.5 rounded text-xs font-medium transition-colors ${
              mode === opt.mode
                ? 'bg-surface-hover text-foreground'
                : 'text-subtle hover:text-muted hover:bg-surface-hover'
            }`}
            title={opt.label}
          >
            <span className="block leading-none">{opt.icon}</span>
            <span className="block" style={{ fontSize: '9px' }}>
              {opt.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

const statusColors: Record<string, string> = {
  connected: '#34c759',
  connecting: '#f5a623',
  disconnected: '#ff3b30',
}

const statusLabels: Record<string, string> = {
  connected: 'Synced',
  connecting: 'Connecting...',
  disconnected: 'Offline',
}

export function Sidebar() {
  const { issueCountByStatus } = useIssues()
  const navigate = useNavigate()
  const connStatus = useConnectionStatus()

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
    <aside className="flex flex-col h-full border-r border-border w-sidebar min-w-sidebar bg-panel">
      {/* Workspace */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <div className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold bg-accent text-white">
          T
        </div>
        <span className="text-sm font-semibold">Tachyon</span>
        <div className="ml-auto flex items-center gap-1" title={statusLabels[connStatus]}>
          <span
            className="w-2 h-2 rounded-full inline-block"
            style={{ background: statusColors[connStatus] }}
          />
          <span className="text-[10px] text-subtle">
            {connStatus === 'connected' ? '' : statusLabels[connStatus]}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <div className="px-2 py-3">
        {navItems.map((item) => (
          <button
            key={item.id}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-left transition-colors text-muted hover:bg-surface-hover"
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* View Toggle */}
      <div className="px-2 py-2 border-t border-b border-border">
        <div className="px-2 mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-subtle">
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
              className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors text-center block no-underline ${
                currentView === view.id
                  ? 'bg-accent text-white'
                  : 'text-muted'
              }`}
            >
              {view.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Status Filter */}
      <div className="px-2 py-3 flex-1 overflow-y-auto">
        <div className="px-2 mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-subtle">
            Status
          </span>
        </div>
        <button
          className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm transition-colors ${
            statusFilter === null
              ? 'text-foreground bg-surface-hover'
              : 'text-muted hover:bg-surface-hover'
          }`}
          onClick={() => handleStatusFilter(null)}
        >
          <span>All</span>
          <span className="text-xs text-subtle">
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
            className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm transition-colors ${
              statusFilter === key
                ? 'text-foreground bg-surface-hover'
                : 'text-muted hover:bg-surface-hover'
            }`}
            onClick={() =>
              handleStatusFilter(statusFilter === key ? null : key)
            }
          >
            <span className="flex items-center gap-2">
              <span style={{ color: config.color }}>{config.icon}</span>
              <span>{config.label}</span>
            </span>
            <span className="text-xs text-subtle">
              {issueCountByStatus[key] || 0}
            </span>
          </button>
        ))}
      </div>

      {/* Teams */}
      <div className="px-2 py-3 border-t border-border">
        <div className="px-2 mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-subtle">
            Projects
          </span>
        </div>
        {teamItems.map((item) => (
          <button
            key={item.id}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm transition-colors text-muted hover:bg-surface-hover"
          >
            <span className="w-2 h-2 rounded-full bg-accent" />
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Theme Toggle */}
      <ThemeToggle />
    </aside>
  )
}
