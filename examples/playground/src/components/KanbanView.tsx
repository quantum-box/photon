import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  type DatabaseRecord,
  type Status,
  statusConfig,
  priorityConfig,
} from '../data/mock'
import type { RecordPropertyKey } from '../lib/databaseViews/types'

interface KanbanViewProps {
  records: DatabaseRecord[]
  selectedRecordId: string | null
  onSelectRecord: (record: DatabaseRecord) => void
  onMoveRecord: (recordId: string, newStatus: Status) => void
  compact?: boolean
  onCompactChange?: (compact: boolean) => void
  visibleProperties?: RecordPropertyKey[]
}

const kanbanStatuses: Status[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
]

// Compact card for kanban
export function KanbanCard({
  record,
  isSelected,
  onClick,
  compact,
  visibleProperties,
}: {
  record: DatabaseRecord
  isSelected: boolean
  onClick: () => void
  compact?: boolean
  visibleProperties?: RecordPropertyKey[]
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: record.id, data: { status: record.status } })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const priority = priorityConfig[record.priority]
  const isVisible = (property: RecordPropertyKey) =>
    !visibleProperties || visibleProperties.includes(property)

  if (compact) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={`rounded p-2 mb-1.5 cursor-grab active:cursor-grabbing border ${
          isSelected
            ? 'bg-surface-hover border-accent'
            : 'bg-surface border-border'
        }`}
        onClick={onClick}
      >
        <div className="flex items-center gap-1.5">
          {isVisible('priority') && (
            <span style={{ color: priority.color }} className="text-xs shrink-0">
              {priority.icon}
            </span>
          )}
          {isVisible('title') && (
            <span className="text-xs truncate flex-1">{record.title}</span>
          )}
          {isVisible('assignee') && record.assignee && (
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 bg-accent text-white"
              style={{ fontSize: '9px' }}
            >
              {record.assignee[0]}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md p-3 mb-2 cursor-grab active:cursor-grabbing border ${
        isSelected
          ? 'bg-surface-hover border-accent'
          : 'bg-surface border-border'
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-1">
        {isVisible('identifier') ? (
          <span className="font-mono text-subtle" style={{ fontSize: '10px' }}>
            {record.identifier}
          </span>
        ) : (
          <span />
        )}
        {isVisible('priority') && (
          <span style={{ color: priority.color }} className="text-xs">
            {priority.icon}
          </span>
        )}
      </div>
      {isVisible('title') && <p className="text-sm mb-2 leading-snug">{record.title}</p>}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {isVisible('labels') && record.labels.slice(0, 2).map((label) => (
            <span
              key={label}
              className="px-1 py-0.5 rounded bg-canvas text-subtle"
              style={{ fontSize: '10px' }}
            >
              {label}
            </span>
          ))}
        </div>
        {isVisible('assignee') && record.assignee && (
          <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 bg-accent text-white">
            {record.assignee[0]}
          </span>
        )}
      </div>
    </div>
  )
}

export function OverlayCard({ record }: { record: DatabaseRecord }) {
  const priority = priorityConfig[record.priority]
  return (
    <div
      className="rounded-md p-3 cursor-grabbing bg-surface border border-accent"
      style={{
        width: '260px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-subtle" style={{ fontSize: '10px' }}>
          {record.identifier}
        </span>
        <span style={{ color: priority.color }} className="text-xs">
          {priority.icon}
        </span>
      </div>
      <p className="text-sm leading-snug">{record.title}</p>
    </div>
  )
}

export function KanbanColumn({
  status,
  records,
  selectedRecordId,
  onSelectRecord,
  compact,
  visibleProperties,
}: {
  status: Status
  records: DatabaseRecord[]
  selectedRecordId: string | null
  onSelectRecord: (record: DatabaseRecord) => void
  compact: boolean
  visibleProperties?: RecordPropertyKey[]
}) {
  const config = statusConfig[status]
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  })

  return (
    <div className="flex w-[82vw] max-w-[280px] shrink-0 flex-col sm:w-[280px]">
      <div className="flex items-center gap-2 px-3 py-2 mb-1">
        <span style={{ color: config.color }}>{config.icon}</span>
        <span className="text-xs font-medium">{config.label}</span>
        <span className="text-xs px-1.5 rounded-full bg-surface-hover text-subtle">
          {records.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className="flex-1 overflow-y-auto px-2 pb-4 rounded-md transition-colors"
        style={{
          minHeight: '100px',
          background: isOver ? 'rgba(91,91,247,0.05)' : 'transparent',
          border: isOver ? '1px dashed var(--accent)' : '1px dashed transparent',
        }}
      >
        <SortableContext
          items={records.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {records.map((record) => (
            <KanbanCard
              key={record.id}
              record={record}
              isSelected={record.id === selectedRecordId}
              onClick={() => onSelectRecord(record)}
              compact={compact}
              visibleProperties={visibleProperties}
            />
          ))}
        </SortableContext>
        {records.length === 0 && (
          <div className="text-center py-8 text-xs text-subtle">
            No records
          </div>
        )}
      </div>
    </div>
  )
}

export function KanbanView({
  records,
  selectedRecordId,
  onSelectRecord,
  onMoveRecord,
  compact: controlledCompact,
  onCompactChange,
  visibleProperties,
}: KanbanViewProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [internalCompact, setInternalCompact] = useState(false)
  const compact = controlledCompact ?? internalCompact
  const setCompact = onCompactChange ?? setInternalCompact

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const recordsByStatus = kanbanStatuses.reduce(
    (acc, status) => {
      acc[status] = records.filter((i) => i.status === status)
      return acc
    },
    {} as Record<Status, DatabaseRecord[]>
  )

  const activeDatabaseRecord = activeId
    ? records.find((i) => i.id === activeId)
    : null

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over) return

    const activeRecordId = active.id as string
    const overId = over.id as string

    // Dropped over a column droppable
    if (overId.startsWith('column-')) {
      const newStatus = over.data.current?.status as Status
      const activeRecordItem = records.find((i) => i.id === activeRecordId)
      if (activeRecordItem && activeRecordItem.status !== newStatus) {
        onMoveRecord(activeRecordId, newStatus)
      }
      return
    }

    // Dropped over another card
    const overDatabaseRecord = records.find((i) => i.id === overId)
    if (overDatabaseRecord) {
      const activeRecordItem = records.find((i) => i.id === activeRecordId)
      if (activeRecordItem && activeRecordItem.status !== overDatabaseRecord.status) {
        onMoveRecord(activeRecordId, overDatabaseRecord.status)
      }
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)

    if (!over) return

    const activeRecordId = active.id as string
    const overId = over.id as string

    if (overId.startsWith('column-')) {
      const newStatus = over.data.current?.status as Status
      onMoveRecord(activeRecordId, newStatus)
      return
    }

    const overDatabaseRecord = records.find((i) => i.id === overId)
    if (overDatabaseRecord) {
      const activeRecordItem = records.find((i) => i.id === activeRecordId)
      if (activeRecordItem && activeRecordItem.status !== overDatabaseRecord.status) {
        onMoveRecord(activeRecordId, overDatabaseRecord.status)
      }
    }
  }

  return (
    <div className="flex h-full flex-col p-1 md:p-2">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 md:px-4">
        <button
          className={`px-2 py-1 rounded text-xs transition-colors border border-border ${
            compact ? 'bg-accent text-white' : 'bg-surface text-muted'
          }`}
          onClick={() => setCompact(!compact)}
        >
          {compact ? 'Compact' : 'Default'}
        </button>
        <span className="min-w-0 truncate text-xs text-subtle">
          {records.length} records · drag to move
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2 md:gap-3 md:p-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {kanbanStatuses.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              records={recordsByStatus[status]}
              selectedRecordId={selectedRecordId}
              onSelectRecord={onSelectRecord}
              compact={compact}
              visibleProperties={visibleProperties}
            />
          ))}
          <DragOverlay>
            {activeDatabaseRecord ? <OverlayCard record={activeDatabaseRecord} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}
