import { priorityConfig, statusConfig, type DatabaseRecord, type Priority, type Status } from '../data/mock'
import {
  RECORD_PROPERTIES,
  isRecordPropertyKey,
} from '../lib/databaseViews/databaseViews'
import type {
  DatabaseViewDefinition,
  DatabaseViewFilters,
  DatabaseViewSorting,
  RecordPropertyKey,
} from '../lib/databaseViews/types'

const sortableProperties = RECORD_PROPERTIES.filter((property) => property.id !== 'labels')

function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, 'ja-JP')
  )
}

function toggleValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value]
}

function updateFilters(
  view: DatabaseViewDefinition,
  patch: Partial<DatabaseViewFilters>
): DatabaseViewDefinition {
  return {
    ...view,
    filters: {
      ...view.filters,
      ...patch,
      labels: patch.labels ?? view.filters.labels,
    },
  }
}

function updateVisibleProperties(
  view: DatabaseViewDefinition,
  property: RecordPropertyKey
): DatabaseViewDefinition {
  const visible = view.visibleProperties.includes(property)
  if (visible && view.visibleProperties.length <= 1) return view
  return {
    ...view,
    visibleProperties: visible
      ? view.visibleProperties.filter((candidate) => candidate !== property)
      : [...view.visibleProperties, property],
  }
}

export function DatabaseViewSettingsPanel({
  open,
  records,
  view,
  onChangeView,
}: {
  open: boolean
  records: DatabaseRecord[]
  view: DatabaseViewDefinition
  onChangeView: (view: DatabaseViewDefinition) => void
}) {
  const assignees = uniqueValues(records.map((record) => record.assignee))
  const projects = uniqueValues(records.map((record) => record.project))
  const labels = uniqueValues(records.flatMap((record) => record.labels))

  if (!open || view.type === 'workflow') return null

  const setSorting = (sorting: DatabaseViewSorting | null) => {
    onChangeView({ ...view, sorting })
  }

  return (
    <aside
      data-testid="database-filter-panel"
      className="hidden w-72 shrink-0 border-l border-border bg-panel p-3 md:flex md:flex-col"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-subtle">
          View Settings
        </span>
      </div>

      <label className="mb-3 flex flex-col gap-1 text-xs text-subtle">
        Search
        <input
          data-testid="view-search-filter"
          value={view.filters.search}
          onChange={(event) =>
            onChangeView(updateFilters(view, { search: event.target.value }))
          }
          className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none focus:border-accent"
          placeholder="Filter records..."
        />
      </label>

      <div className="mb-4">
        <span className="mb-1 block text-xs font-medium text-subtle">Status</span>
        <div className="flex flex-col gap-1">
          <button
            className={`flex items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
              !view.filters.status
                ? 'bg-surface-hover text-foreground'
                : 'text-muted hover:bg-surface-hover'
            }`}
            onClick={() => onChangeView(updateFilters(view, { status: undefined }))}
          >
            <span>All records</span>
            <span className="text-xs text-subtle">{records.length}</span>
          </button>
          {(Object.entries(statusConfig) as [Status, (typeof statusConfig)[Status]][]).map(
            ([key, config]) => (
              <button
                key={key}
                className={`flex items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
                  view.filters.status === key
                    ? 'bg-surface-hover text-foreground'
                    : 'text-muted hover:bg-surface-hover'
                }`}
                onClick={() =>
                  onChangeView(
                    updateFilters(view, {
                      status: view.filters.status === key ? undefined : key,
                    })
                  )
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span style={{ color: config.color }}>{config.icon}</span>
                  <span className="truncate">{config.label}</span>
                </span>
                <span className="text-xs text-subtle">
                  {records.filter((record) => record.status === key).length}
                </span>
              </button>
            )
          )}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2">
        <label className="flex flex-col gap-1 text-xs text-subtle">
          Priority
          <select
            value={view.filters.priority ?? ''}
            onChange={(event) =>
              onChangeView(
                updateFilters(view, {
                  priority: event.target.value ? (event.target.value as Priority) : undefined,
                })
              )
            }
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none"
          >
            <option value="">Any priority</option>
            {(Object.entries(priorityConfig) as [Priority, (typeof priorityConfig)[Priority]][]).map(
              ([key, config]) => (
                <option key={key} value={key}>
                  {config.label}
                </option>
              )
            )}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-subtle">
          Assignee
          <select
            value={view.filters.assignee ?? ''}
            onChange={(event) =>
              onChangeView(
                updateFilters(view, {
                  assignee: event.target.value || undefined,
                })
              )
            }
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none"
          >
            <option value="">Anyone</option>
            {assignees.map((assignee) => (
              <option key={assignee} value={assignee}>
                {assignee}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-subtle">
          Project
          <select
            value={view.filters.project ?? ''}
            onChange={(event) =>
              onChangeView(
                updateFilters(view, {
                  project: event.target.value || undefined,
                })
              )
            }
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none"
          >
            <option value="">Any project</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </label>
      </div>

      {labels.length > 0 && (
        <div className="mb-4">
          <span className="mb-1 block text-xs font-medium text-subtle">Labels</span>
          <div className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <button
                key={label}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  view.filters.labels.includes(label)
                    ? 'bg-accent text-white'
                    : 'bg-surface-hover text-muted hover:text-foreground'
                }`}
                onClick={() =>
                  onChangeView(updateFilters(view, { labels: toggleValue(view.filters.labels, label) }))
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-[1fr_auto] gap-2">
        <label className="flex flex-col gap-1 text-xs text-subtle">
          Sort
          <select
            value={view.sorting?.id ?? ''}
            onChange={(event) => {
              const id = event.target.value
              setSorting(isRecordPropertyKey(id) ? { id, desc: view.sorting?.desc ?? false } : null)
            }}
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none"
          >
            <option value="">Default</option>
            {sortableProperties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.label}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="toggle-sort-direction"
          className="self-end rounded bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-40"
          disabled={!view.sorting}
          onClick={() =>
            view.sorting && setSorting({ ...view.sorting, desc: !view.sorting.desc })
          }
        >
          {view.sorting?.desc ? 'Desc' : 'Asc'}
        </button>
      </div>

      {view.type === 'board' && (
        <label className="mb-4 flex items-center justify-between gap-3 rounded bg-surface px-2 py-2 text-sm text-muted">
          Compact cards
          <input
            data-testid="board-compact-toggle"
            type="checkbox"
            checked={view.board.compact}
            onChange={(event) =>
              onChangeView({
                ...view,
                board: { ...view.board, compact: event.target.checked },
              })
            }
          />
        </label>
      )}

      <div>
        <span className="mb-1 block text-xs font-medium text-subtle">Properties</span>
        <div className="grid grid-cols-2 gap-1">
          {RECORD_PROPERTIES.map((property) => (
            <label
              key={property.id}
              className="flex items-center gap-2 rounded bg-surface px-2 py-1.5 text-xs text-muted"
            >
              <input
                type="checkbox"
                checked={view.visibleProperties.includes(property.id)}
                onChange={() => onChangeView(updateVisibleProperties(view, property.id))}
              />
              <span>{property.label}</span>
            </label>
          ))}
        </div>
      </div>
    </aside>
  )
}
