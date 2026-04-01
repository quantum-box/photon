import { useMemo, useState } from 'react'
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
import {
  type Issue,
  type Status,
  statusConfig,
  priorityConfig,
} from '../data/mock'

interface TableViewProps {
  issues: Issue[]
  selectedIssueId: string | null
  onSelectIssue: (issue: Issue) => void
}

const columnHelper = createColumnHelper<Issue>()

export function TableView({ issues, selectedIssueId, onSelectIssue }: TableViewProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')

  const columns = useMemo(
    () => [
      columnHelper.accessor('identifier', {
        header: 'ID',
        size: 90,
        cell: (info) => (
          <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        size: 130,
        cell: (info) => {
          const s = statusConfig[info.getValue()]
          return (
            <span className="flex items-center gap-1.5">
              <span style={{ color: s.color }}>{s.icon}</span>
              <span className="text-xs">{s.label}</span>
            </span>
          )
        },
        filterFn: (row, _id, filterValue: Status) => {
          return row.original.status === filterValue
        },
      }),
      columnHelper.accessor('priority', {
        header: 'Priority',
        size: 100,
        cell: (info) => {
          const p = priorityConfig[info.getValue()]
          return (
            <span className="flex items-center gap-1.5">
              <span style={{ color: p.color }}>{p.icon}</span>
              <span className="text-xs">{p.label}</span>
            </span>
          )
        },
      }),
      columnHelper.accessor('title', {
        header: 'Title',
        size: 400,
        cell: (info) => (
          <span className="text-sm truncate block">{info.getValue()}</span>
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
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {info.getValue()}
          </span>
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
    []
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

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-2 border-b"
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
          {table.getFilteredRowModel().rows.length} issues
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full" style={{ minWidth: '900px' }}>
          <thead>
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
                      cursor: header.column.getCanSort() ? 'pointer' : 'default',
                    }}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
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
                        (e.currentTarget.style.background = 'var(--border-color)')
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
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer transition-colors"
                style={{
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
                    className="px-3 py-2"
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
