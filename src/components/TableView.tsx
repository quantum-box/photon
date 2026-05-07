import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
  type OnChangeFn,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type Issue,
  type Status,
  type Priority,
  statusConfig,
  priorityConfig,
  mockUsers,
} from '../data/mock'

interface TableViewProps {
  issues: Issue[]
  selectedIssueId: string | null
  onSelectIssue: (issue: Issue) => void
  onUpdateIssue: (issueId: string, field: keyof Issue, value: string) => void
  onCreateIssue: (data: { title: string }) => void
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
}

const columnHelper = createColumnHelper<Issue>()

// Inline editable cell (double-click to edit text fields)
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
        className="w-full px-1 py-0.5 rounded text-sm outline-none bg-canvas border border-accent text-foreground"
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

// Portal-based dropdown for cell editing (escapes overflow:auto container)
function CellDropdown({
  open,
  anchorRef,
  onClose,
  children,
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  children: React.ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (open && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      const menuHeight = 240
      const spaceBelow = window.innerHeight - rect.bottom
      const top =
        spaceBelow < menuHeight ? rect.top - menuHeight : rect.bottom + 2
      setPos({ top, left: rect.left })
    }
  }, [open, anchorRef])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={menuRef}
      className="bg-surface border border-border rounded-md shadow-soft min-w-40 max-h-60 overflow-y-auto"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        padding: '4px 0',
      }}
    >
      {children}
    </div>,
    document.body
  )
}

function DropdownItem({
  selected,
  onClick,
  children,
}: {
  selected?: boolean
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 transition-colors text-foreground hover:bg-surface-hover ${
        selected ? 'bg-surface-hover' : ''
      }`}
    >
      {children}
    </button>
  )
}

// Status dropdown cell (single click, color badge)
function StatusDropdownCell({
  value,
  issueId,
  onUpdate,
}: {
  value: Status
  issueId: string
  onUpdate: (issueId: string, field: keyof Issue, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const config = statusConfig[value]

  return (
    <div ref={ref}>
      <span
        className="inline-flex items-center gap-1.5 cursor-pointer rounded-full px-2 py-0.5 transition-colors"
        style={{ color: config.color }}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: config.color }}
        />
        <span className="text-xs font-medium">{config.label}</span>
      </span>
      <CellDropdown open={open} anchorRef={ref} onClose={() => setOpen(false)}>
        {(
          Object.entries(statusConfig) as [
            Status,
            (typeof statusConfig)[Status],
          ][]
        ).map(([key, sc]) => (
          <DropdownItem
            key={key}
            selected={key === value}
            onClick={(e) => {
              e.stopPropagation()
              onUpdate(issueId, 'status', key)
              setOpen(false)
            }}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: sc.color }}
            />
            <span>{sc.icon}</span>
            <span>{sc.label}</span>
          </DropdownItem>
        ))}
      </CellDropdown>
    </div>
  )
}

// Priority dropdown cell (single click)
function PriorityDropdownCell({
  value,
  issueId,
  onUpdate,
}: {
  value: Priority
  issueId: string
  onUpdate: (issueId: string, field: keyof Issue, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const config = priorityConfig[value]

  return (
    <div ref={ref}>
      <span
        className="flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 -mx-1 transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span style={{ color: config.color }}>{config.icon}</span>
        <span className="text-xs">{config.label}</span>
      </span>
      <CellDropdown open={open} anchorRef={ref} onClose={() => setOpen(false)}>
        {(
          Object.entries(priorityConfig) as [
            Priority,
            (typeof priorityConfig)[Priority],
          ][]
        ).map(([key, pc]) => (
          <DropdownItem
            key={key}
            selected={key === value}
            onClick={(e) => {
              e.stopPropagation()
              onUpdate(issueId, 'priority', key)
              setOpen(false)
            }}
          >
            <span style={{ color: pc.color }}>{pc.icon}</span>
            <span>{pc.label}</span>
          </DropdownItem>
        ))}
      </CellDropdown>
    </div>
  )
}

// Assignee dropdown cell (single click, avatar + name)
function AssigneeDropdownCell({
  value,
  issueId,
  onUpdate,
}: {
  value: string | null
  issueId: string
  onUpdate: (issueId: string, field: keyof Issue, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div ref={ref}>
      <span
        className="flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 -mx-1 transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        {value ? (
          <>
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 bg-accent text-white">
              {value[0]}
            </span>
            <span className="text-xs truncate">{value}</span>
          </>
        ) : (
          <span className="text-xs text-subtle">
            —
          </span>
        )}
      </span>
      <CellDropdown open={open} anchorRef={ref} onClose={() => setOpen(false)}>
        <DropdownItem
          selected={value === null}
          onClick={(e) => {
            e.stopPropagation()
            onUpdate(issueId, 'assignee', '')
            setOpen(false)
          }}
        >
          <span className="text-xs text-subtle">
            None
          </span>
        </DropdownItem>
        {mockUsers.map((name) => (
          <DropdownItem
            key={name}
            selected={name === value}
            onClick={(e) => {
              e.stopPropagation()
              onUpdate(issueId, 'assignee', name)
              setOpen(false)
            }}
          >
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 bg-accent text-white">
              {name[0]}
            </span>
            <span>{name}</span>
          </DropdownItem>
        ))}
      </CellDropdown>
    </div>
  )
}

const ROW_HEIGHT = 40

function MobileIssueCard({
  issue,
  isSelected,
  onSelectIssue,
  onUpdateIssue,
}: {
  issue: Issue
  isSelected: boolean
  onSelectIssue: (issue: Issue) => void
  onUpdateIssue: (issueId: string, field: keyof Issue, value: string) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        isSelected
          ? 'border-accent bg-surface-hover'
          : 'border-border bg-surface hover:bg-surface-hover'
      }`}
      onClick={() => onSelectIssue(issue)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelectIssue(issue)
        }
      }}
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <span className="font-mono text-xs text-subtle">{issue.identifier}</span>
        <PriorityDropdownCell
          value={issue.priority}
          issueId={issue.id}
          onUpdate={onUpdateIssue}
        />
      </div>
      <div className="mb-3 line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {issue.title}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <StatusDropdownCell
          value={issue.status}
          issueId={issue.id}
          onUpdate={onUpdateIssue}
        />
        <div className="flex min-w-0 items-center gap-2">
          {issue.assignee && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-white">
                {issue.assignee[0]}
              </span>
              <span className="truncate">{issue.assignee}</span>
            </span>
          )}
          <span className="shrink-0 text-xs text-subtle">
            {new Date(issue.updatedAt).toLocaleDateString('ja-JP', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        </div>
      </div>
      {issue.labels.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {issue.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="rounded bg-canvas px-1.5 py-0.5 text-xs text-subtle"
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function TableView({
  issues,
  selectedIssueId,
  onSelectIssue,
  onUpdateIssue,
  onCreateIssue,
  sorting: controlledSorting,
  onSortingChange: controlledOnSortingChange,
}: TableViewProps) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([])
  const sorting = controlledSorting ?? internalSorting
  const onSortingChange = controlledOnSortingChange ?? setInternalSorting
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [creatingIssue, setCreatingIssue] = useState(false)
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)
  const newIssueInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creatingIssue && newIssueInputRef.current) {
      newIssueInputRef.current.focus()
    }
  }, [creatingIssue])

  const columns = useMemo(
    () => [
      columnHelper.accessor('identifier', {
        header: 'ID',
        size: 90,
        cell: (info) => (
          <span className="font-mono text-xs text-subtle">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        size: 140,
        cell: (info) => (
          <StatusDropdownCell
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
          <PriorityDropdownCell
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
        cell: (info) => (
          <AssigneeDropdownCell
            value={info.getValue()}
            issueId={info.row.original.id}
            onUpdate={onUpdateIssue}
          />
        ),
      }),
      columnHelper.accessor('labels', {
        header: 'Labels',
        size: 160,
        cell: (info) => (
          <div className="flex gap-1 flex-wrap">
            {info.getValue().map((label) => (
              <span
                key={label}
                className="px-1.5 py-0.5 rounded text-xs bg-surface-hover text-muted"
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
          <span className="text-xs text-subtle">
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
    onSortingChange,
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

  const handleCreateSubmit = useCallback(() => {
    const trimmed = newIssueTitle.trim()
    if (trimmed) {
      onCreateIssue({ title: trimmed })
      setNewIssueTitle('')
      setCreatingIssue(false)
    }
  }, [newIssueTitle, onCreateIssue])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 md:gap-3 md:px-4 border-b border-border shrink-0">
        <div className="relative flex-1 min-w-0 md:max-w-xs">
          <input
            type="text"
            placeholder="Filter issues..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full px-3 py-1.5 rounded text-sm outline-none bg-surface border border-border text-foreground"
          />
        </div>
        <span className="shrink-0 text-xs text-subtle">
          {rows.length} issues
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 md:hidden">
        <div className="space-y-2">
          {rows.map((row) => (
            <MobileIssueCard
              key={row.id}
              issue={row.original}
              isSelected={row.original.id === selectedIssueId}
              onSelectIssue={onSelectIssue}
              onUpdateIssue={onUpdateIssue}
            />
          ))}
          {creatingIssue ? (
            <input
              ref={newIssueInputRef}
              type="text"
              value={newIssueTitle}
              onChange={(e) => setNewIssueTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateSubmit()
                if (e.key === 'Escape') {
                  setCreatingIssue(false)
                  setNewIssueTitle('')
                }
              }}
              onBlur={() => {
                if (!newIssueTitle.trim()) {
                  setCreatingIssue(false)
                  setNewIssueTitle('')
                }
              }}
              placeholder="Issue title を入力して Enter..."
              className="w-full rounded-md border border-accent bg-canvas px-3 py-2 text-sm text-foreground outline-none"
            />
          ) : (
            <button
              className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-3 py-3 text-xs text-subtle transition-colors hover:border-accent hover:text-foreground"
              onClick={() => setCreatingIssue(true)}
            >
              <span>+</span>
              <span>New Issue</span>
            </button>
          )}
        </div>
      </div>

      {/* Table with virtual scroll */}
      <div ref={parentRef} className="hidden flex-1 overflow-auto md:block">
        <table className="w-full" style={{ minWidth: '900px' }}>
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="text-left text-xs font-medium px-3 py-2 select-none relative text-subtle bg-surface border-b border-border"
                    style={{
                      width: header.getSize(),
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
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none hover:bg-border"
                      style={{
                        background: header.column.getIsResizing()
                          ? 'var(--accent)'
                          : 'transparent',
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
                  className={`cursor-pointer transition-colors border-b border-border ${
                    row.original.id === selectedIssueId
                      ? 'bg-surface-hover'
                      : 'hover:bg-surface'
                  }`}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => onSelectIssue(row.original)}
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
            {/* New Issue row */}
            <tr className="border-b border-border" style={{ height: ROW_HEIGHT }}>
              <td colSpan={columns.length} className="px-3 py-1.5">
                {creatingIssue ? (
                  <input
                    ref={newIssueInputRef}
                    type="text"
                    value={newIssueTitle}
                    onChange={(e) => setNewIssueTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateSubmit()
                      if (e.key === 'Escape') {
                        setCreatingIssue(false)
                        setNewIssueTitle('')
                      }
                    }}
                    onBlur={() => {
                      if (!newIssueTitle.trim()) {
                        setCreatingIssue(false)
                        setNewIssueTitle('')
                      }
                    }}
                    placeholder="Issue title を入力して Enter..."
                    className="w-full px-2 py-1 rounded text-sm outline-none bg-canvas border border-accent text-foreground max-w-lg"
                  />
                ) : (
                  <button
                    className="flex items-center gap-1 text-xs cursor-pointer transition-colors text-subtle hover:text-foreground"
                    onClick={() => setCreatingIssue(true)}
                  >
                    <span>+</span>
                    <span>New Issue</span>
                  </button>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
