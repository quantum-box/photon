/* eslint-disable react-refresh/only-export-components */
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Kbd, KbdGroup } from '../components/Kbd'
import {
  getDatabaseViewScopeId,
  getDefaultDatabaseViewId,
} from '../lib/databaseViews/databaseViews'
import type { DatabaseViewType } from '../lib/databaseViews/types'
import type { RecordSearchParams } from './searchParams'

const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true

  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

function shortcutViewLabel(view: DatabaseViewType | 'docs' | 'chat' | 'sync' | 'library') {
  switch (view) {
    case 'table':
      return 'Table'
    case 'board':
      return 'Board'
    case 'workflow':
      return 'Workflow'
    case 'docs':
      return 'Docs'
    case 'chat':
      return 'Chat'
    case 'sync':
      return 'Sync'
    case 'library':
      return 'Library'
  }
}

type ShortcutAction = DatabaseViewType | 'docs' | 'chat' | 'sync' | 'library'

const goShortcutActions: Record<string, ShortcutAction> = {
  t: 'table',
  b: 'board',
  w: 'workflow',
  d: 'docs',
  c: 'chat',
  s: 'sync',
  l: 'library',
}

function modifierKeyLabel() {
  return isMacPlatform() ? '⌘' : 'Ctrl'
}

function renderShortcutKeys(keys: string[]) {
  return (
    <KbdGroup>
      {keys.map((key, index) => (
        <Kbd key={`${key}-${index}`}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}

function renderShortcutSequence(keys: string[]) {
  return (
    <KbdGroup>
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className="inline-flex items-center gap-1">
          {index > 0 && <span className="text-[10px] text-subtle">then</span>}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </KbdGroup>
  )
}

export function KeyboardShortcutsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const modifier = modifierKeyLabel()
  const shortcuts = [
    { keys: renderShortcutKeys(['C']), label: 'New record' },
    { keys: renderShortcutKeys(['/']), label: 'Focus record search' },
    { keys: renderShortcutKeys([modifier, 'F']), label: 'Focus record search' },
    { keys: renderShortcutKeys([modifier, 'B']), label: 'Toggle table or board' },
    { keys: renderShortcutKeys([modifier, 'K']), label: 'Open command menu' },
    { keys: renderShortcutSequence(['G', 'T']), label: shortcutViewLabel('table') },
    { keys: renderShortcutSequence(['G', 'B']), label: shortcutViewLabel('board') },
    { keys: renderShortcutSequence(['G', 'W']), label: shortcutViewLabel('workflow') },
    { keys: renderShortcutSequence(['G', 'D']), label: shortcutViewLabel('docs') },
    { keys: renderShortcutSequence(['G', 'C']), label: shortcutViewLabel('chat') },
    { keys: renderShortcutSequence(['G', 'S']), label: shortcutViewLabel('sync') },
    { keys: renderShortcutSequence(['G', 'L']), label: shortcutViewLabel('library') },
    { keys: renderShortcutKeys(['?']), label: 'Show shortcuts' },
  ]

  return (
    <div
      data-testid="keyboard-shortcuts-panel"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-4 text-foreground shadow-soft">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Command Menu</h2>
          <button
            type="button"
            aria-label="Close keyboard shortcuts"
            className="flex h-7 w-7 items-center justify-center rounded bg-surface-hover text-xs text-muted hover:text-foreground"
            onClick={onClose}
          >
            x
          </button>
        </div>
        <div className="space-y-1">
          {shortcuts.map((shortcut, index) => (
            <div key={`${shortcut.label}-${index}`} className="flex items-center justify-between gap-4 rounded px-1 py-1.5">
              <span className="text-xs text-muted">{shortcut.label}</span>
              {shortcut.keys}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function useGlobalKeyboardShortcuts(setCreateModalOpen: (open: boolean) => void) {
  const navigate = useNavigate()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const goModeTimerRef = useRef<number | null>(null)
  const location = useRouterState({ select: (state) => state.location })
  const search = location.search as RecordSearchParams

  const closeGoMode = useCallback(() => {
    if (goModeTimerRef.current !== null) {
      window.clearTimeout(goModeTimerRef.current)
      goModeTimerRef.current = null
    }
  }, [])

  const navigateToDatabaseView = useCallback(
    (type: DatabaseViewType) => {
      const database = search.database
      void navigate({
        to: '/databases',
        search: {
          database,
          view: getDefaultDatabaseViewId(getDatabaseViewScopeId(database), type),
        },
      })
    },
    [navigate, search.database]
  )

  const runShortcutAction = useCallback(
    (target: ShortcutAction) => {
      if (target === 'docs') {
        void navigate({ to: '/docs' })
      } else if (target === 'chat') {
        void navigate({ to: '/chat' })
      } else if (target === 'sync') {
        void navigate({ to: '/sync' })
      } else if (target === 'library') {
        void navigate({ to: '/library' })
      } else {
        navigateToDatabaseView(target)
      }
    },
    [navigate, navigateToDatabaseView]
  )

  const focusRecordSearch = useCallback(() => {
    navigateToDatabaseView('table')
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="records-global-filter"]')
      input?.focus()
      input?.select()
    }, 50)
  }, [navigateToDatabaseView])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const usesShortcutModifier = isMacPlatform() ? event.metaKey : event.ctrlKey

      if (!isEditableShortcutTarget(event.target) && (event.key === '?' || (event.key === '/' && event.shiftKey))) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }

      if (goModeTimerRef.current !== null) {
        const target = goShortcutActions[event.key.toLowerCase()]
        closeGoMode()
        if (!target || isEditableShortcutTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

        event.preventDefault()
        runShortcutAction(target)
        return
      }

      if (!isEditableShortcutTarget(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key.toLowerCase() === 'c') {
          event.preventDefault()
          if (!location.pathname.startsWith('/databases')) {
            navigateToDatabaseView('table')
          }
          setCreateModalOpen(true)
          return
        }

        if (event.key === '/') {
          event.preventDefault()
          focusRecordSearch()
          return
        }

        if (event.key.toLowerCase() === 'g') {
          event.preventDefault()
          closeGoMode()
          goModeTimerRef.current = window.setTimeout(() => {
            goModeTimerRef.current = null
          }, 1200)
          return
        }
      }

      if (!usesShortcutModifier || event.altKey) return
      const key = event.key.toLowerCase()

      if (key === 'k') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }

      if (key === 'f') {
        event.preventDefault()
        focusRecordSearch()
        return
      }

      if (key === 'b') {
        event.preventDefault()
        const currentView = typeof search.view === 'string' && search.view.includes(':board') ? 'board' : 'table'
        navigateToDatabaseView(currentView === 'board' ? 'table' : 'board')
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      closeGoMode()
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    closeGoMode,
    focusRecordSearch,
    location.pathname,
    navigate,
    navigateToDatabaseView,
    runShortcutAction,
    search.view,
    setCreateModalOpen,
  ])

  return {
    shortcutsOpen,
    closeShortcuts: () => setShortcutsOpen(false),
  }
}
