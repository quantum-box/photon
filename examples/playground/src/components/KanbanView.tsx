import { memo, useMemo, useState } from 'react'
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
import { useRecordField } from '@quantum-box/photon-react'
import {
  type DatabaseRecord,
  type Status,
  type Priority,
  statusConfig,
  priorityConfig,
} from '../data/mock'
import { RECORDS_COLLECTION } from '../contexts/RecordsContext'
import type { RecordPropertyKey } from '../lib/databaseViews/types'

interface KanbanViewProps {
  records: DatabaseRecord[]
  selectedRecordId: string | null
  onSelectRecord: (recordId: string) => void
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

// Module-level so the sensor descriptor keeps its identity: an inline options
// literal would rebuild the sensors array every render, which cascades into a
// fresh DndContext internal context and re-renders every card.
const pointerSensorOptions = { activationConstraint: { distance: 5 } }

// Compact card for kanban. The card carries recordId only and subscribes to
// its own fields, so a delta on one record re-renders exactly one card.
export const KanbanCard = memo(function KanbanCard({
  recordId,
  isSelected,
  onSelect,
  compact,
  visibleProperties,
}: {
  recordId: string
  isSelected: boolean
  onSelect: (recordId: string) => void
  compact?: boolean
  visibleProperties?: RecordPropertyKey[]
}) {
  const status = useRecordField<Status>(RECORDS_COLLECTION, recordId, 'status')
  const identifier = useRecordField<string>(RECORDS_COLLECTION, recordId, 'identifier')
  const title = useRecordField<string>(RECORDS_COLLECTION, recordId, 'title')
  const priorityKey = useRecordField<Priority>(RECORDS_COLLECTION, recordId, 'priority')
  const assignee = useRecordField<string | null>(RECORDS_COLLECTION, recordId, 'assignee') ?? null
  const labels = useRecordField<string[]>(RECORDS_COLLECTION, recordId, 'labels') ?? []

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: recordId, data: { status } })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const priority = priorityKey ? priorityConfig[priorityKey] : null
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
        onClick={() => onSelect(recordId)}
      >
        <div className="flex items-center gap-1.5">
          {isVisible('priority') && priority && (
            <span style={{ color: priority.color }} className="text-xs shrink-0">
              {priority.icon}
            </span>
          )}
          {isVisible('title') && (
            <span className="text-xs truncate flex-1">{title}</span>
          )}
          {isVisible('assignee') && assignee && (
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 bg-accent text-white"
              style={{ fontSize: '9px' }}
            >
              {assignee[0]}
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
      onClick={() => onSelect(recordId)}
    >
      <div className="flex items-center justify-between mb-1">
        {isVisible('identifier') ? (
          <span className="font-mono text-subtle" style={{ fontSize: '10px' }}>
            {identifier}
          </span>
        ) : (
          <span />
        )}
        {isVisible('priority') && priority && (
          <span style={{ color: priority.color }} className="text-xs">
            {priority.icon}
          </span>
        )}
      </div>
      {isVisible('title') && <p className="text-sm mb-2 leading-snug">{title}</p>}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {isVisible('labels') && labels.slice(0, 2).map((label) => (
            <span
              key={label}
              className="px-1 py-0.5 rounded bg-canvas text-subtle"
              style={{ fontSize: '10px' }}
            >
              {label}
            </span>
          ))}
        </div>
        {isVisible('assignee') && assignee && (
          <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 bg-accent text-white">
            {assignee[0]}
          </span>
        )}
      </div>
    </div>
  )
})

export function OverlayCard({ recordId }: { recordId: string }) {
  const identifier = useRecordField<string>(RECORDS_COLLECTION, recordId, 'identifier')
  const title = useRecordField<string>(RECORDS_COLLECTION, recordId, 'title')
  const priorityKey = useRecordField<Priority>(RECORDS_COLLECTION, recordId, 'priority')
  const priority = priorityKey ? priorityConfig[priorityKey] : null
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
          {identifier}
        </span>
        {priority && (
          <span style={{ color: priority.color }} className="text-xs">
            {priority.icon}
          </span>
        )}
      </div>
      <p className="text-sm leading-snug">{title}</p>
    </div>
  )
}

export function KanbanColumn({
  status,
  recordIds,
  selectedRecordId,
  onSelectRecord,
  compact,
  visibleProperties,
}: {
  status: Status
  recordIds: string[]
  selectedRecordId: string | null
  onSelectRecord: (recordId: string) => void
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
          {recordIds.length}
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
          items={recordIds}
          strategy={verticalListSortingStrategy}
        >
          {recordIds.map((recordId) => (
            <KanbanCard
              key={recordId}
              recordId={recordId}
              isSelected={recordId === selectedRecordId}
              onSelect={onSelectRecord}
              compact={compact}
              visibleProperties={visibleProperties}
            />
          ))}
        </SortableContext>
        {recordIds.length === 0 && (
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
    useSensor(PointerSensor, pointerSensorOptions),
    useSensor(KeyboardSensor)
  )

  // Serialize the grouping into a key so the id arrays keep their identity
  // across deltas that don't move a record — SortableContext derives its
  // context value from `items`, so a fresh array per render would re-render
  // every card through useSortable and defeat the per-field subscriptions.
  const recordIdsKey = useMemo(
    () =>
      JSON.stringify(
        kanbanStatuses.map((status) => [
          status,
          records
            .filter((record) => record.status === status)
            .map((record) => record.id),
        ])
      ),
    [records]
  )
  const recordIdsByStatus = useMemo(
    () =>
      Object.fromEntries(
        JSON.parse(recordIdsKey) as [Status, string[]][]
      ) as Record<Status, string[]>,
    [recordIdsKey]
  )

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
              recordIds={recordIdsByStatus[status]}
              selectedRecordId={selectedRecordId}
              onSelectRecord={onSelectRecord}
              compact={compact}
              visibleProperties={visibleProperties}
            />
          ))}
          <DragOverlay>
            {activeId ? <OverlayCard recordId={activeId} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}
