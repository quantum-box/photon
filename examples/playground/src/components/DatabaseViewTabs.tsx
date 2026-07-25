import { useState } from 'react'
import type { DatabaseViewDefinition, DatabaseViewType } from '../lib/databaseViews/types'

const viewTypeMeta: Record<DatabaseViewType, { icon: string; label: string }> = {
  table: { icon: '▦', label: 'Table' },
  board: { icon: '▤', label: 'Board' },
  workflow: { icon: '◇', label: 'Workflow' },
}

function legacyTestId(view: DatabaseViewDefinition) {
  if (view.id.endsWith(':table')) return 'view-table'
  if (view.id.endsWith(':board')) return 'view-kanban'
  if (view.id.endsWith(':workflow')) return 'view-workflow'
  return `database-view-tab-${view.id}`
}

export function DatabaseViewTabs({
  views,
  selectedView,
  dirty,
  onSelectView,
  onCreateView,
  onRenameView,
  onDuplicateView,
  onDeleteView,
  onSaveView,
  onDiscardChanges,
}: {
  views: DatabaseViewDefinition[]
  selectedView: DatabaseViewDefinition
  dirty: boolean
  onSelectView: (view: DatabaseViewDefinition) => void
  onCreateView: (type: DatabaseViewType) => void
  onRenameView: (view: DatabaseViewDefinition) => void
  onDuplicateView: (view: DatabaseViewDefinition) => void
  onDeleteView: (view: DatabaseViewDefinition) => void
  onSaveView: () => void
  onDiscardChanges: () => void
}) {
  const [optionsOpen, setOptionsOpen] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Database views">
          {views.map((view) => {
            const meta = viewTypeMeta[view.type]
            const selected = view.id === selectedView.id
            return (
              <button
                key={view.id}
                data-testid={legacyTestId(view)}
                className={`flex min-w-20 items-center justify-center gap-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  selected
                    ? 'bg-accent text-white'
                    : 'bg-surface-hover text-muted hover:text-foreground'
                }`}
                onClick={() => onSelectView(view)}
                title={`${view.name} (${meta.label})`}
              >
                <span className="shrink-0">{meta.icon}</span>
                <span className="truncate">{view.name}</span>
                {selected && dirty && (
                  <span aria-label="Unsaved changes" className="shrink-0">
                    *
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        {dirty && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              data-testid="save-view"
              className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-white"
              onClick={onSaveView}
            >
              Save view
            </button>
            <button
              data-testid="discard-view-changes"
              className="rounded bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
              onClick={onDiscardChanges}
            >
              Discard
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <button
            type="button"
            data-testid="view-options"
            className="list-none rounded bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
            onClick={() => setOptionsOpen((open) => !open)}
          >
            View options
          </button>
          {optionsOpen && (
            <div className="absolute left-0 top-8 z-20 flex w-36 flex-col gap-1 rounded border border-border bg-panel p-1 shadow-xl">
              <button
                data-testid="rename-view"
                className="rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-foreground"
                onClick={() => onRenameView(selectedView)}
              >
                Rename
              </button>
              <button
                data-testid="duplicate-view"
                className="rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-foreground"
                onClick={() => onDuplicateView(selectedView)}
              >
                Duplicate
              </button>
              <button
                data-testid="delete-view"
                className="rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={views.length <= 1}
                onClick={() => onDeleteView(selectedView)}
              >
                Delete
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden text-xs text-subtle sm:inline">New</span>
          <button
            data-testid="new-table-view"
            className="rounded bg-surface-hover px-2 py-1.5 text-xs text-muted hover:text-foreground"
            onClick={() => onCreateView('table')}
          >
            Table
          </button>
          <button
            data-testid="new-board-view"
            className="rounded bg-surface-hover px-2 py-1.5 text-xs text-muted hover:text-foreground"
            onClick={() => onCreateView('board')}
          >
            Board
          </button>
          <button
            data-testid="new-workflow-view"
            className="rounded bg-surface-hover px-2 py-1.5 text-xs text-muted hover:text-foreground"
            onClick={() => onCreateView('workflow')}
          >
            Workflow
          </button>
        </div>
      </div>
    </div>
  )
}
