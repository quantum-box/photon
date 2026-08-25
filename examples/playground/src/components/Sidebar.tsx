import { useNavigate, useRouterState, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Status } from '../data/mock'
import { useLiveRecords } from '../contexts/RecordsContext'
import { useWorkspaceDatabases } from '../contexts/DatabasesContext'
import { useTheme } from '../contexts/ThemeContext'
import { useAuth } from '../contexts/AuthContext'
import type { ThemeMode } from '../contexts/ThemeContext'
import { useConnectionStatus, useSyncPresence } from '../lib/yjs/usePresence'
import { appKitConfig, switchTenantWorkspace } from '../app/kitConfig'
import type { TenantWorkspaceOption } from '../app/kitConfig'
import {
  getDatabaseViewScopeId,
  getDefaultDatabaseViewId,
} from '../lib/databaseViews/databaseViews'
import type { DatabaseViewType } from '../lib/databaseViews/types'

const workspaceLinks = [
  { id: 'docs' as const, label: 'Docs', to: '/docs' as const },
  { id: 'chat' as const, label: 'Chat', to: '/chat' as const },
  { id: 'sync' as const, label: 'Sync', to: '/sync' as const },
  { id: 'library' as const, label: 'Library', to: '/library' as const },
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

function tenantWorkspaceValue(option: TenantWorkspaceOption) {
  return `${option.tenantId}::${option.workspaceId}`
}

function TenantWorkspaceSwitcher() {
  const options = appKitConfig.tenancy.availableWorkspaces
  if (options.length <= 1) return null

  const currentValue = tenantWorkspaceValue({
    tenantId: appKitConfig.tenant.id,
    tenantName: appKitConfig.tenant.name,
    workspaceId: appKitConfig.workspace.id,
    workspaceName: appKitConfig.workspace.name,
    workspaceInitial: appKitConfig.workspace.initial,
  })

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = options.find((option) => tenantWorkspaceValue(option) === event.target.value)
    if (next && tenantWorkspaceValue(next) !== currentValue) {
      switchTenantWorkspace(next)
    }
  }

  return (
    <div className="border-b border-border px-3 py-2">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-subtle">
        Tenant
      </label>
      <select
        data-testid="tenant-workspace-switcher"
        className="mt-1 w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-foreground outline-none focus:border-accent"
        value={currentValue}
        onChange={handleChange}
      >
        {options.map((option) => (
          <option key={tenantWorkspaceValue(option)} value={tenantWorkspaceValue(option)}>
            {option.tenantName} / {option.workspaceName}
          </option>
        ))}
      </select>
    </div>
  )
}

export function Sidebar() {
  const records = useLiveRecords()
  const { databases, addDatabase, removeDatabase, canRemoveDatabase } = useWorkspaceDatabases()
  const navigate = useNavigate()
  const connStatus = useConnectionStatus()
  const { onlineCount } = useSyncPresence()
  const auth = useAuth()
  const [newDatabaseName, setNewDatabaseName] = useState('')
  const [sideNavOpen, setSideNavOpen] = useState(true)
  const [contextMenu, setContextMenu] = useState<{
    databaseId: string | null
    label: string
    count: number
    x: number
    y: number
    canDelete: boolean
  } | null>(null)

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.search }) as {
    database?: string
    status?: Status
    view?: string
  }
  const selectedDatabaseId = search.database

  const currentDatabaseViewType: DatabaseViewType = search.view?.includes(':workflow')
    ? 'workflow'
    : search.view?.includes(':board')
      ? 'board'
      : 'table'

  const currentView = pathname.startsWith('/databases/board')
    ? 'board'
    : pathname.startsWith('/databases/workflow')
      ? 'workflow'
    : pathname.startsWith('/docs') || pathname.startsWith('/documents')
      ? 'docs'
    : pathname.startsWith('/chat')
      ? 'chat'
    : pathname.startsWith('/sync')
      ? 'sync'
    : pathname.startsWith('/library')
      ? 'library'
      : currentDatabaseViewType

  const handleDatabaseSelect = (databaseId: string | null) => {
    const nextDatabaseId = databaseId ?? undefined
    const databaseViewType =
      currentView === 'board' || currentView === 'workflow' || currentView === 'table'
        ? currentView
        : 'table'
    const view = getDefaultDatabaseViewId(
      getDatabaseViewScopeId(nextDatabaseId),
      databaseViewType
    )

    void navigate({
      to: '/databases',
      search: { database: nextDatabaseId, view },
    })
  }

  const handleDatabaseContextMenu = (
    event: ReactMouseEvent,
    database: { id: string | null; label: string; count: number }
  ) => {
    event.preventDefault()
    setContextMenu({
      databaseId: database.id,
      label: database.label,
      count: database.count,
      x: event.clientX,
      y: event.clientY,
      canDelete: canRemoveDatabase(database.id),
    })
  }

  const closeContextMenu = () => setContextMenu(null)

  const copyDatabaseLink = async () => {
    if (!contextMenu || typeof window === 'undefined') return
    const url = new URL('/databases', window.location.origin)
    const databaseId = contextMenu.databaseId ?? undefined
    url.searchParams.set(
      'view',
      getDefaultDatabaseViewId(getDatabaseViewScopeId(databaseId), currentDatabaseViewType)
    )
    if (databaseId) url.searchParams.set('database', databaseId)
    await navigator.clipboard.writeText(url.toString())
    closeContextMenu()
  }

  const deleteContextDatabase = () => {
    if (!contextMenu?.databaseId || !contextMenu.canDelete) return
    const confirmed = window.confirm(`Delete "${contextMenu.label}" database?`)
    if (!confirmed) return

    const deleted = removeDatabase(contextMenu.databaseId)
    closeContextMenu()
    if (deleted && selectedDatabaseId === contextMenu.databaseId) {
      handleDatabaseSelect(null)
    }
  }

  useEffect(() => {
    if (!contextMenu) return

    const close = () => closeContextMenu()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu()
    }

    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  const handleCreateDatabase = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const database = addDatabase(newDatabaseName)
    if (!database) return

    setNewDatabaseName('')
    handleDatabaseSelect(database.id)
  }

  const workspaceHeader = (presenceTestId: string) => (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border md:border-b">
      <div className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold bg-accent text-white">
        {appKitConfig.workspace.initial}
      </div>
      <span className="text-sm font-semibold">{appKitConfig.workspace.name}</span>
      <div
        className="ml-auto flex items-center gap-1 min-w-0"
        title={connStatus === 'connected' ? `${onlineCount} online` : statusLabels[connStatus]}
      >
        <span
          className="w-2 h-2 rounded-full inline-block shrink-0"
          style={{ background: statusColors[connStatus] }}
        />
        <span
          data-testid={presenceTestId}
          className="text-[10px] text-subtle truncate max-w-20"
        >
          {connStatus === 'connected' ? `${onlineCount} online` : statusLabels[connStatus]}
        </span>
      </div>
    </div>
  )

  const databaseFilters = (
    <>
      <button
        className={`flex shrink-0 items-center justify-between gap-2 rounded px-2 py-1.5 text-sm transition-colors md:w-full ${
          !selectedDatabaseId
            ? 'bg-surface-hover text-foreground'
            : 'text-muted hover:bg-surface-hover'
        }`}
        onClick={() => handleDatabaseSelect(null)}
        onContextMenu={(event) =>
          handleDatabaseContextMenu(event, {
            id: null,
            label: 'All databases',
            count: records.length,
          })
        }
      >
        <span>All databases</span>
        <span className="text-xs text-subtle">{records.length}</span>
      </button>
      {databases.map((item) => {
        const count = records.filter((record) => record.project === item.label).length
        return (
          <button
            key={item.id}
            data-testid={`database-${item.id}`}
            className={`flex shrink-0 items-center justify-between gap-2 rounded px-2 py-1.5 text-sm transition-colors md:w-full ${
              selectedDatabaseId === item.id
                ? 'bg-surface-hover text-foreground'
                : 'text-muted hover:bg-surface-hover'
            }`}
            onClick={() => handleDatabaseSelect(item.id)}
            onContextMenu={(event) =>
              handleDatabaseContextMenu(event, {
                id: item.id,
                label: item.label,
                count,
              })
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
              <span className="truncate">{item.label}</span>
            </span>
            <span className="text-xs text-subtle">{count}</span>
          </button>
        )
      })}
      <form className="mt-2 flex gap-1 px-0.5" onSubmit={handleCreateDatabase}>
        <input
          data-testid="new-database-name"
          value={newDatabaseName}
          onChange={(event) => setNewDatabaseName(event.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder="New database"
        />
        <button
          data-testid="create-database"
          type="submit"
          className="rounded bg-surface-hover px-2 py-1 text-xs font-medium text-muted hover:text-foreground"
        >
          Add
        </button>
      </form>
    </>
  )

  const workspaceNavigation = (testIdSuffix = '') => (
    <div className="grid grid-cols-4 gap-1 px-1">
      {workspaceLinks.map((view) => (
        <Link
          key={view.id}
          data-testid={`view-${view.id}${testIdSuffix}`}
          to={view.to}
          className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors text-center block no-underline ${
            currentView === view.id
              ? 'bg-accent text-white'
              : 'text-muted'
          }`}
        >
          <span className="block truncate">{view.label}</span>
        </Link>
      ))}
    </div>
  )

  const authControls = auth.enabled ? (
    <div className="border-t border-border px-3 py-2">
      <div className="min-w-0 text-[11px] text-subtle">
        <span className="block truncate">
          {auth.session?.user?.email ?? 'Authenticated'}
        </span>
      </div>
      <button
        type="button"
        className="mt-1 w-full rounded bg-surface-hover px-2 py-1.5 text-xs font-medium text-muted hover:text-foreground"
        onClick={auth.signOut}
      >
        Sign out
      </button>
    </div>
  ) : null

  return (
    <>
      <div className="flex shrink-0 flex-col border-b border-border bg-panel md:hidden">
        {workspaceHeader('sync-presence-status-mobile')}
        <TenantWorkspaceSwitcher />
        <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-2">
          {databaseFilters}
        </div>
        <div className="px-2 py-2">
          {workspaceNavigation('-mobile')}
        </div>
        {authControls}
      </div>

      {!sideNavOpen && (
        <aside
          data-testid="side-nav"
          className="hidden h-full w-16 shrink-0 flex-col items-center border-r border-border bg-panel px-2 py-3 md:flex"
        >
          <button
            data-testid="toggle-side-nav"
            className="mb-3 flex h-7 w-full items-center justify-center rounded bg-surface-hover text-[10px] font-semibold text-muted hover:text-foreground"
            title="Open sidebar"
            onClick={() => setSideNavOpen(true)}
          >
            Open
          </button>
          <div className="mt-auto flex flex-col gap-1">
            {workspaceLinks.map((view) => (
              <Link
                key={view.id}
                data-testid={`view-${view.id}`}
                to={view.to}
                className={`flex h-8 w-8 items-center justify-center rounded text-[10px] font-medium no-underline transition-colors ${
                  currentView === view.id ? 'bg-accent text-white' : 'text-muted hover:bg-surface-hover'
                }`}
                title={view.label}
              >
                {view.label.slice(0, 1)}
              </Link>
            ))}
          </div>
        </aside>
      )}

      {sideNavOpen && (
      <aside data-testid="side-nav" className="hidden md:flex flex-col h-full border-r border-border w-sidebar min-w-sidebar bg-panel">
        {/* Workspace */}
        <div className="relative">
          {workspaceHeader('sync-presence-status')}
          <button
            data-testid="toggle-side-nav"
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded bg-surface-hover text-xs text-muted hover:text-foreground"
            title="Close sidebar"
            onClick={() => setSideNavOpen(false)}
          >
            ‹
          </button>
        </div>
        <TenantWorkspaceSwitcher />

      {/* Navigation */}
      <div className="px-2 py-3">
        {appKitConfig.workspace.primaryNav.map((item) => (
          <button
            key={item.id}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-left transition-colors text-muted hover:bg-surface-hover"
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Databases */}
      <div className="px-2 py-3 border-t border-border">
        <div className="px-2 mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-subtle">
            Databases
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {databaseFilters}
        </div>
      </div>

      {/* Workspace Views */}
      <div className="px-2 py-3 flex-1 overflow-y-auto border-t border-border">
        <div className="px-2 mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-subtle">
            Workspace
          </span>
        </div>
        {workspaceNavigation()}
      </div>

      {/* Theme Toggle */}
      {authControls}
      <ThemeToggle />
      </aside>
      )}
      {contextMenu &&
        createPortal(
          <div
            data-testid="database-context-menu"
            role="menu"
            className="min-w-52 rounded-md border border-border bg-surface p-1 text-sm text-foreground shadow-soft"
            style={{
              position: 'fixed',
              left: Math.min(contextMenu.x, window.innerWidth - 220),
              top: Math.min(contextMenu.y, window.innerHeight - 150),
              zIndex: 10000,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-2 py-1.5">
              <div className="truncate text-xs font-medium text-foreground">
                {contextMenu.label}
              </div>
              <div className="text-[11px] text-subtle">
                {contextMenu.count} records
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              data-testid="database-context-open"
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-foreground"
              onClick={() => {
                handleDatabaseSelect(contextMenu.databaseId)
                closeContextMenu()
              }}
            >
              Open database
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="database-context-copy-link"
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-foreground"
              onClick={() => void copyDatabaseLink()}
            >
              Copy link
            </button>
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              role="menuitem"
              data-testid="database-context-delete"
              disabled={!contextMenu.canDelete}
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-red-500 hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-subtle"
              onClick={deleteContextDatabase}
              title={contextMenu.canDelete ? 'Delete database' : 'Default databases cannot be deleted'}
            >
              Delete database
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
