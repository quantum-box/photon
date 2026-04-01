import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type Issue,
  type Status,
  type Priority,
  statusConfig,
  priorityConfig,
} from '../data/mock'

interface TableViewProps {
  issues: Issue[]
  selectedIssueId: string | null
  onSelectIssue: (issue: Issue) => void
  onUpdateIssue: (issueId: string, field: keyof Issue, value: string) => void
}

const columnHelper = createColumnHelper<Issue>()

// Inline editable cell
function EditableCell({
  value,
  issueId,
  field,
  onUpdate,
}: {
  value: string
  issueId: string
  field: keyof Issue
  onUpdate: (issueId: string, field: keyof Issue, value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    if (editValue !== value) {
      onUpdate(issueId, field, editValue)
    }
  }, [editValue, value, issueId, field, onUpdate])

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setEditValue(value)
            setEditing(false)
          }
        }}
        className="w-full px-1 py-0.5 rounded text-sm outline-none"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className="text-sm truncate block cursor-text rounded px-1 py-0.5 -mx-1 transition-colors"
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      style={{ minHeight: '24px' }}
      title="ダブルクリックで編集"
    >
      {value}
    </span>
  )
}

// Status select cell
function StatusSelectCell({
  value,
  issueId,
  onUpdate,
}: {
  value: Status
  issueId: string
  onUpdate: (issueId: string, field: keyof Issue, value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const config = statusConfig[value]

  if (editing) {
    return (
      <select
        value={value}
        onChange={(e) => {
          onUpdate(issueId, 'status', e.target.value)
          setEditing(false)
        }}
        onBlur={() => setEditing(false)}
        autoFocus
        className="text-xs outline-none rounded px-1 py-0.5"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {(Object.entries(statusConfig) as [Status, typeof config][]).map(([key, sc]) => (
          <option key={key} value={key}>
            {sc.icon} {sc.label}
          </option>
        ))}
      </select>
    )
  }

  return (
    <span
      className="flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 -mx-1 transition-colors"
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      title="ダブルクリックで変更"
    >
      <span style={{ color: config.color }}>{config.icon}</span>
      <span className="text-xs">{config.label}</span>
    </span>
  )
}

// Priority select cell
function PrioritySelectCell({
  value,
  issueId,
  onUpdate,
}: {
  value: Priority
  issueId: string
  onUpdate: (issueId: string, field: keyof Issue, value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const config = priorityConfig[value]

  if (editing) {
    return (
      <select
        value={value}
        onChange={(e) => {
          onUpdate(issueId, 'priority', e.target.value)
          setEditing(false)
        }}
        onBlur={() => setEditing(false)}
        autoFocus
        className="text-xs outline-none rounded px-1 py-0.5"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {(Object.entries(priorityConfig) as [Priority, typeof config][]).map(
          ([key, pc]) => (
            <option key={key} value={key}>
              {pc.icon} {pc.label}
            </option>
          )
        )}
      </select>
    )
  }

  return (
    <span
      className="flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 -mx-1 transition-colors"
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      title="ダブルクリックで変更"
    >
      <span style={{ color: config.color }}>{config.icon}</span>
      <span className="text-xs">{config.label}</span>
    </span>
  )
}

const ROW_HEIGHT = 40

export function TableView({
  issues,
  selectedIssueId,
  onSelectIssue,
  onUpdateIssue,
}: TableViewProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)

  const columns = useMemo(
    () => [
      columnHelper.accessor('identifier', {
        header: 'ID',
        size: 90,
        cell: (info) => (
          <span
            className="font-mono text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        size: 140,
        cell: (info) => (
          <StatusSelectCell
            value={info.getValue()}
            issueId={info.row.original.id}
            onUpdate={onUpdateIssue}
          />
        ),
        filterFn: (row, _id, filterValue: Status) =>
          row.original.status === filterValue,
      }),
      columnHelper.accessor('priority', {
        header: 'Priority',
        size: 110,
        cell: (info) => (
          <PrioritySelectCell
            value={info.getValue()}
            issueId={info.row.original.id}
            onUpdate={onUpdateIssue}
          />
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Title',
        size: 400,
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            issueId={info.row.original.id}
            field="title"
            onUpdate={onUpdateIssue}
          />
        ),
      }),
      columnHelper.accessor('assignee', {
        header: 'Assignee',
        size: 140,
        cell: (info) => {
          const name = info.getValue()
          if (!name)
            return (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                —
              </span>
            )
          return (
            <span className="flex items-center gap-1.5">
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                {name[0]}
              </span>
              <span className="text-xs truncate">{name}</span>
            </span>
          )
        },
      }),
      columnHelper.accessor('labels', {
        header: 'Labels',
        size: 160,
        cell: (info) => (
          <div className="flex gap-1 flex-wrap">
            {info.getValue().map((label) => (
              <span
                key={label}
                className="px-1.5 py-0.5 rounded text-xs"
                style={{
                  background: 'var(--bg-hover)',
                  color: 'var(--text-secondary)',
                }}
              >
                {label}
              </span>
            ))}
          </div>
        ),
        enableSorting: false,
      }),
      columnHelper.accessor('project', {
        header: 'Project',
        size: 130,
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            issueId={info.row.original.id}
            field="project"
            onUpdate={onUpdateIssue}
          />
        ),
      }),
      columnHelper.accessor('updatedAt', {
        header: 'Updated',
        size: 100,
        cell: (info) => (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {new Date(info.getValue()).toLocaleDateString('ja-JP', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        ),
      }),
    ],
    [onUpdateIssue]
  )

  const table = useReactTable({
    data: issues,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange',
  })

  const { rows } = table.getRowModel()

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            placeholder="Filter issues..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full px-3 py-1.5 rounded text-sm outline-none"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
            }}
          />
        </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {rows.length} issues
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          · double-click to edit
        </span>
      </div>

      {/* Table with virtual scroll */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        <table className="w-full" style={{ minWidth: '900px' }}>
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="text-left text-xs font-medium px-3 py-2 select-none relative"
                    style={{
                      width: header.getSize(),
                      color: 'var(--text-muted)',
                      background: 'var(--bg-surface)',
                      borderBottom: '1px solid var(--border-color)',
                      cursor: header.column.getCanSort()
                        ? 'pointer'
                        : 'default',
                    }}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {{
                        asc: ' ↑',
                        desc: ' ↓',
                      }[header.column.getIsSorted() as string] ?? null}
                    </div>
                    {/* Resize handle */}
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none"
                      style={{
                        background: header.column.getIsResizing()
                          ? 'var(--accent)'
                          : 'transparent',
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background =
                          'var(--border-color)')
                      }
                      onMouseLeave={(e) => {
                        if (!header.column.getIsResizing())
                          e.currentTarget.style.background = 'transparent'
                      }}
                    />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {/* Virtual spacer top */}
            {virtualizer.getVirtualItems().length > 0 && (
              <tr>
                <td
                  style={{
                    height: virtualizer.getVirtualItems()[0]?.start ?? 0,
                    padding: 0,
                    border: 'none',
                  }}
                />
              </tr>
            )}
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              return (
                <tr
                  key={row.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="cursor-pointer transition-colors"
                  style={{
                    height: ROW_HEIGHT,
                    background:
                      row.original.id === selectedIssueId
                        ? 'var(--bg-hover)'
                        : 'transparent',
                    borderBottom: '1px solid var(--border-color)',
                  }}
                  onClick={() => onSelectIssue(row.original)}
                  onMouseEnter={(e) => {
                    if (row.original.id !== selectedIssueId)
                      e.currentTarget.style.background = 'var(--bg-surface)'
                  }}
                  onMouseLeave={(e) => {
                    if (row.original.id !== selectedIssueId)
                      e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-3 py-1.5"
                      style={{ width: cell.column.getSize() }}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
            {/* Virtual spacer bottom */}
            {virtualizer.getVirtualItems().length > 0 && (
              <tr>
                <td
                  style={{
                    height:
                      virtualizer.getTotalSize() -
                      (virtualizer.getVirtualItems().at(-1)?.end ?? 0),
                    padding: 0,
                    border: 'none',
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
