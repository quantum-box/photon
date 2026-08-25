import { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react'
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
  type ColumnSizingState,
  type OnChangeFn,
  type VisibilityState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRecordField } from '@quantum-box/photon-react'
import {
  type DatabaseRecord,
  type Status,
  type Priority,
  statusConfig,
  priorityConfig,
  mockUsers,
} from '../data/mock'
import { RECORDS_COLLECTION } from '../contexts/RecordsContext'
import { Kbd, KbdGroup } from './Kbd'
import type { RecordPropertyKey } from '../lib/databaseViews/types'

type UpdateRecordFn = (recordId: string, field: keyof DatabaseRecord, value: string) => void

interface TableViewProps {
  records: DatabaseRecord[]
  selectedRecordId: string | null
  onSelectRecord: (recordId: string) => void
  onUpdateRecord: UpdateRecordFn
  onCreateRecord: (data: { title: string }) => void
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  globalFilter?: string
  onGlobalFilterChange?: (value: string) => void
  visibleProperties?: RecordPropertyKey[]
}

const columnHelper = createColumnHelper<DatabaseRecord>()

// One source of truth for column order and default widths: the tanstack
// column defs (header, sorting, filtering, resizing) and the hand-rendered
// body rows below both derive from it.
const COLUMN_ORDER: RecordPropertyKey[] = [
  'identifier',
  'status',
  'priority',
  'title',
  'assignee',
  'labels',
  'project',
  'updatedAt',
]

const COLUMN_SIZES: Record<RecordPropertyKey, number> = {
  identifier: 90,
  status: 140,
  priority: 110,
  title: 400,
  assignee: 140,
  labels: 160,
  project: 130,
  updatedAt: 100,
}

// ---------------------------------------------------------------------------
// Field cells — each one subscribes to its own field with useRecordField, so
// a delta on one field re-renders exactly one cell ("one delta, one cell").
// The surrounding rows only carry recordId and structural props.
// ---------------------------------------------------------------------------

// Inline editable cell (double-click to edit text fields)
function EditableFieldCell({
  recordId,
  field,
  onUpdate,
}: {
  recordId: string
  field: 'title' | 'project'
  onUpdate: UpdateRecordFn
}) {
  const value = useRecordField<string>(RECORDS_COLLECTION, recordId, field) ?? ''
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
      onUpdate(recordId, field, editValue)
    }
  }, [editValue, value, recordId, field, onUpdate])

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
        setEditValue(value)
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
  recordId,
  onUpdate,
}: {
  recordId: string
  onUpdate: UpdateRecordFn
}) {
  const value = useRecordField<Status>(RECORDS_COLLECTION, recordId, 'status')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  if (!value) return null
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
              onUpdate(recordId, 'status', key)
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
  recordId,
  onUpdate,
}: {
  recordId: string
  onUpdate: UpdateRecordFn
}) {
  const value = useRecordField<Priority>(RECORDS_COLLECTION, recordId, 'priority')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  if (!value) return null
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
              onUpdate(recordId, 'priority', key)
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
  recordId,
  onUpdate,
}: {
  recordId: string
  onUpdate: UpdateRecordFn
}) {
  const value = useRecordField<string | null>(RECORDS_COLLECTION, recordId, 'assignee') ?? null
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
            onUpdate(recordId, 'assignee', '')
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
              onUpdate(recordId, 'assignee', name)
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

function IdentifierCell({ recordId }: { recordId: string }) {
  const identifier = useRecordField<string>(RECORDS_COLLECTION, recordId, 'identifier')
  return <span className="font-mono text-xs text-subtle">{identifier}</span>
}

function LabelsCell({ recordId }: { recordId: string }) {
  const labels = useRecordField<string[]>(RECORDS_COLLECTION, recordId, 'labels') ?? []
  return (
    <div className="flex gap-1 flex-wrap">
      {labels.map((label) => (
        <span
          key={label}
          className="px-1.5 py-0.5 rounded text-xs bg-surface-hover text-muted"
        >
          {label}
        </span>
      ))}
    </div>
  )
}

function UpdatedAtCell({ recordId }: { recordId: string }) {
  const updatedAt = useRecordField<string>(RECORDS_COLLECTION, recordId, 'updatedAt')
  if (!updatedAt) return null
  return (
    <span className="text-xs text-subtle">
      {new Date(updatedAt).toLocaleDateString('ja-JP', {
        month: 'short',
        day: 'numeric',
      })}
    </span>
  )
}

function RecordFieldCell({
  columnId,
  recordId,
  onUpdate,
}: {
  columnId: RecordPropertyKey
  recordId: string
  onUpdate: UpdateRecordFn
}) {
  switch (columnId) {
    case 'identifier':
      return <IdentifierCell recordId={recordId} />
    case 'status':
      return <StatusDropdownCell recordId={recordId} onUpdate={onUpdate} />
    case 'priority':
      return <PriorityDropdownCell recordId={recordId} onUpdate={onUpdate} />
    case 'title':
      return <EditableFieldCell recordId={recordId} field="title" onUpdate={onUpdate} />
    case 'assignee':
      return <AssigneeDropdownCell recordId={recordId} onUpdate={onUpdate} />
    case 'labels':
      return <LabelsCell recordId={recordId} />
    case 'project':
      return <EditableFieldCell recordId={recordId} field="project" onUpdate={onUpdate} />
    case 'updatedAt':
      return <UpdatedAtCell recordId={recordId} />
  }
}

interface RowColumn {
  id: RecordPropertyKey
  width: number
}

// The row carries recordId and structure only — no record values — so the
// memo holds across list invalidations and field deltas land on single cells.
const TableRow = memo(function TableRow({
  recordId,
  isSelected,
  columns,
  virtualIndex,
  measureElement,
  onSelect,
  onUpdate,
}: {
  recordId: string
  isSelected: boolean
  columns: RowColumn[]
  virtualIndex: number
  measureElement: (node: Element | null) => void
  onSelect: (recordId: string) => void
  onUpdate: UpdateRecordFn
}) {
  return (
    <tr
      data-index={virtualIndex}
      ref={measureElement}
      className={`cursor-pointer transition-colors border-b border-border ${
        isSelected ? 'bg-surface-hover' : 'hover:bg-surface'
      }`}
      style={{ height: ROW_HEIGHT }}
      onClick={() => onSelect(recordId)}
    >
      {columns.map((column) => (
        <td
          key={column.id}
          className="px-3 py-1.5"
          style={{ width: column.width }}
        >
          <RecordFieldCell
            columnId={column.id}
            recordId={recordId}
            onUpdate={onUpdate}
          />
        </td>
      ))}
    </tr>
  )
})

const ROW_HEIGHT = 40
const MOBILE_VIEWPORT_QUERY = '(max-width: 767px)'

function getIsMobileViewport() {
  return typeof window !== 'undefined'
    ? window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
    : false
}

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(getIsMobileViewport)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_QUERY)
    const update = () => setIsMobile(mediaQuery.matches)

    update()
    mediaQuery.addEventListener('change', update)
    return () => mediaQuery.removeEventListener('change', update)
  }, [])

  return isMobile
}

const MobileRecordCard = memo(function MobileRecordCard({
  recordId,
  isSelected,
  onSelect,
  onUpdate,
  visibleProperties,
}: {
  recordId: string
  isSelected: boolean
  onSelect: (recordId: string) => void
  onUpdate: UpdateRecordFn
  visibleProperties?: RecordPropertyKey[]
}) {
  const identifier = useRecordField<string>(RECORDS_COLLECTION, recordId, 'identifier')
  const title = useRecordField<string>(RECORDS_COLLECTION, recordId, 'title')
  const assignee = useRecordField<string | null>(RECORDS_COLLECTION, recordId, 'assignee') ?? null
  const updatedAt = useRecordField<string>(RECORDS_COLLECTION, recordId, 'updatedAt')
  const labels = useRecordField<string[]>(RECORDS_COLLECTION, recordId, 'labels') ?? []

  const isVisible = (property: RecordPropertyKey) =>
    !visibleProperties || visibleProperties.includes(property)

  return (
    <div
      data-testid="mobile-record-card"
      role="button"
      tabIndex={0}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        isSelected
          ? 'border-accent bg-surface-hover'
          : 'border-border bg-surface hover:bg-surface-hover'
      }`}
      onClick={() => onSelect(recordId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(recordId)
        }
      }}
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        {isVisible('identifier') ? (
          <span className="font-mono text-xs text-subtle">{identifier}</span>
        ) : (
          <span />
        )}
        {isVisible('priority') && (
          <PriorityDropdownCell recordId={recordId} onUpdate={onUpdate} />
        )}
      </div>
      {isVisible('title') && (
        <div className="mb-3 line-clamp-2 text-sm font-medium leading-snug text-foreground">
          {title}
        </div>
      )}
      <div className="flex min-w-0 items-center justify-between gap-2">
        {isVisible('status') ? (
          <StatusDropdownCell recordId={recordId} onUpdate={onUpdate} />
        ) : (
          <span />
        )}
        <div className="flex min-w-0 items-center gap-2">
          {isVisible('assignee') && assignee && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-white">
                {assignee[0]}
              </span>
              <span className="truncate">{assignee}</span>
            </span>
          )}
          {isVisible('updatedAt') && updatedAt && (
            <span className="shrink-0 text-xs text-subtle">
              {new Date(updatedAt).toLocaleDateString('ja-JP', {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          )}
        </div>
      </div>
      {isVisible('labels') && labels.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {labels.slice(0, 3).map((label) => (
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
})

export function TableView({
  records,
  selectedRecordId,
  onSelectRecord,
  onUpdateRecord,
  onCreateRecord,
  sorting: controlledSorting,
  onSortingChange: controlledOnSortingChange,
  globalFilter: controlledGlobalFilter,
  onGlobalFilterChange: controlledOnGlobalFilterChange,
  visibleProperties,
}: TableViewProps) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([])
  const sorting = controlledSorting ?? internalSorting
  const onSortingChange = controlledOnSortingChange ?? setInternalSorting
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
  const [internalGlobalFilter, setInternalGlobalFilter] = useState('')
  const globalFilter = controlledGlobalFilter ?? internalGlobalFilter
  const setGlobalFilter = controlledOnGlobalFilterChange ?? setInternalGlobalFilter
  const [creatingDatabaseRecord, setCreatingDatabaseRecord] = useState(false)
  const [newRecordTitle, setNewRecordTitle] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)
  const newRecordInputRef = useRef<HTMLInputElement>(null)
  const isMobileViewport = useIsMobileViewport()

  useEffect(() => {
    if (creatingDatabaseRecord && newRecordInputRef.current) {
      newRecordInputRef.current.focus()
    }
  }, [creatingDatabaseRecord])

  // The table instance owns ordering concerns only — sorting, filtering,
  // column sizing and visibility. Cell values render outside it, each cell
  // subscribing to its own field.
  const columns = useMemo(
    () => [
      columnHelper.accessor('identifier', {
        header: 'ID',
        size: COLUMN_SIZES.identifier,
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        size: COLUMN_SIZES.status,
        filterFn: (row, _id, filterValue: Status) =>
          row.original.status === filterValue,
      }),
      columnHelper.accessor('priority', {
        header: 'Priority',
        size: COLUMN_SIZES.priority,
      }),
      columnHelper.accessor('title', {
        header: 'Title',
        size: COLUMN_SIZES.title,
      }),
      columnHelper.accessor('assignee', {
        header: 'Assignee',
        size: COLUMN_SIZES.assignee,
      }),
      columnHelper.accessor('labels', {
        header: 'Labels',
        size: COLUMN_SIZES.labels,
        enableSorting: false,
      }),
      columnHelper.accessor('project', {
        header: 'Project',
        size: COLUMN_SIZES.project,
      }),
      columnHelper.accessor('updatedAt', {
        header: 'Updated',
        size: COLUMN_SIZES.updatedAt,
      }),
    ],
    []
  )

  const columnVisibility: VisibilityState | undefined = useMemo(() => {
    if (!visibleProperties) return undefined
    return {
      identifier: visibleProperties.includes('identifier'),
      status: visibleProperties.includes('status'),
      priority: visibleProperties.includes('priority'),
      title: visibleProperties.includes('title'),
      assignee: visibleProperties.includes('assignee'),
      labels: visibleProperties.includes('labels'),
      project: visibleProperties.includes('project'),
      updatedAt: visibleProperties.includes('updatedAt'),
    }
  }, [visibleProperties])

  // Stable while nothing structural changes, so memoized rows skip
  // re-renders when only record values move underneath them.
  const rowColumns: RowColumn[] = useMemo(
    () =>
      COLUMN_ORDER.filter(
        (id) => !visibleProperties || visibleProperties.includes(id)
      ).map((id) => ({ id, width: columnSizing[id] ?? COLUMN_SIZES[id] })),
    [visibleProperties, columnSizing]
  )

  const table = useReactTable({
    data: records,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnSizing,
      ...(columnVisibility ? { columnVisibility } : {}),
    },
    onSortingChange,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnSizingChange: setColumnSizing,
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
    const trimmed = newRecordTitle.trim()
    if (trimmed) {
      onCreateRecord({ title: trimmed })
      setNewRecordTitle('')
      setCreatingDatabaseRecord(false)
    }
  }, [newRecordTitle, onCreateRecord])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 md:gap-3 md:px-4 border-b border-border shrink-0">
        <div className="relative flex-1 min-w-0 md:max-w-xs">
          <input
            data-testid="records-global-filter"
            type="text"
            placeholder="Filter records..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded border border-border bg-surface py-1.5 pl-3 pr-24 text-sm text-foreground outline-none"
          />
          <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1">
            <Kbd>/</Kbd>
            <KbdGroup className="hidden sm:inline-flex">
              <Kbd>{/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>F</Kbd>
            </KbdGroup>
          </div>
        </div>
        <span className="shrink-0 text-xs text-subtle">
          {rows.length} records
        </span>
      </div>

      {isMobileViewport && (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="space-y-2">
            {rows.map((row) => (
              <MobileRecordCard
                key={row.original.id}
                recordId={row.original.id}
                isSelected={row.original.id === selectedRecordId}
                onSelect={onSelectRecord}
                onUpdate={onUpdateRecord}
                visibleProperties={visibleProperties}
              />
            ))}
            {creatingDatabaseRecord ? (
              <input
                ref={newRecordInputRef}
                type="text"
                value={newRecordTitle}
                onChange={(e) => setNewRecordTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateSubmit()
                  if (e.key === 'Escape') {
                    setCreatingDatabaseRecord(false)
                    setNewRecordTitle('')
                  }
                }}
                onBlur={() => {
                  if (!newRecordTitle.trim()) {
                    setCreatingDatabaseRecord(false)
                    setNewRecordTitle('')
                  }
                }}
                placeholder="Record title を入力して Enter..."
                className="w-full rounded-md border border-accent bg-canvas px-3 py-2 text-sm text-foreground outline-none"
              />
            ) : (
              <button
                className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-3 py-3 text-xs text-subtle transition-colors hover:border-accent hover:text-foreground"
                onClick={() => setCreatingDatabaseRecord(true)}
              >
                <span>+</span>
                <span>New Record</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Table with virtual scroll */}
      {!isMobileViewport && (
        <div ref={parentRef} className="flex-1 overflow-auto">
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
                  <TableRow
                    key={row.original.id}
                    recordId={row.original.id}
                    isSelected={row.original.id === selectedRecordId}
                    columns={rowColumns}
                    virtualIndex={virtualRow.index}
                    measureElement={virtualizer.measureElement}
                    onSelect={onSelectRecord}
                    onUpdate={onUpdateRecord}
                  />
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
              {/* New DatabaseRecord row */}
              <tr className="border-b border-border" style={{ height: ROW_HEIGHT }}>
                <td colSpan={table.getVisibleLeafColumns().length} className="px-3 py-1.5">
                  {creatingDatabaseRecord ? (
                    <input
                      ref={newRecordInputRef}
                      type="text"
                      value={newRecordTitle}
                      onChange={(e) => setNewRecordTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreateSubmit()
                        if (e.key === 'Escape') {
                          setCreatingDatabaseRecord(false)
                          setNewRecordTitle('')
                        }
                      }}
                      onBlur={() => {
                        if (!newRecordTitle.trim()) {
                          setCreatingDatabaseRecord(false)
                          setNewRecordTitle('')
                        }
                      }}
                      placeholder="Record title を入力して Enter..."
                      className="w-full px-2 py-1 rounded text-sm outline-none bg-canvas border border-accent text-foreground max-w-lg"
                    />
                  ) : (
                    <button
                      className="flex items-center gap-1 text-xs cursor-pointer transition-colors text-subtle hover:text-foreground"
                      onClick={() => setCreatingDatabaseRecord(true)}
                    >
                      <span>+</span>
                      <span>New Record</span>
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
