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
  type Issue,
  type Status,
  statusConfig,
  priorityConfig,
} from '../data/mock'

interface KanbanViewProps {
  issues: Issue[]
  selectedIssueId: string | null
  onSelectIssue: (issue: Issue) => void
  onMoveIssue: (issueId: string, newStatus: Status) => void
}

const kanbanStatuses: Status[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
]

// Compact card for kanban
function KanbanCard({
  issue,
  isSelected,
  onClick,
  compact,
}: {
  issue: Issue
  isSelected: boolean
  onClick: () => void
  compact?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { status: issue.status } })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const priority = priorityConfig[issue.priority]

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
          <span style={{ color: priority.color }} className="text-xs shrink-0">
            {priority.icon}
          </span>
          <span className="text-xs truncate flex-1">{issue.title}</span>
          {issue.assignee && (
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 bg-accent text-white"
              style={{ fontSize: '9px' }}
            >
              {issue.assignee[0]}
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
        <span className="font-mono text-subtle" style={{ fontSize: '10px' }}>
          {issue.identifier}
        </span>
        <span style={{ color: priority.color }} className="text-xs">
          {priority.icon}
        </span>
      </div>
      <p className="text-sm mb-2 leading-snug">{issue.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {issue.labels.slice(0, 2).map((label) => (
            <span
              key={label}
              className="px-1 py-0.5 rounded bg-canvas text-subtle"
              style={{ fontSize: '10px' }}
            >
              {label}
            </span>
          ))}
        </div>
        {issue.assignee && (
          <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 bg-accent text-white">
            {issue.assignee[0]}
          </span>
        )}
      </div>
    </div>
  )
}

function OverlayCard({ issue }: { issue: Issue }) {
  const priority = priorityConfig[issue.priority]
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
          {issue.identifier}
        </span>
        <span style={{ color: priority.color }} className="text-xs">
          {priority.icon}
        </span>
      </div>
      <p className="text-sm leading-snug">{issue.title}</p>
    </div>
  )
}

function KanbanColumn({
  status,
  issues,
  selectedIssueId,
  onSelectIssue,
  compact,
}: {
  status: Status
  issues: Issue[]
  selectedIssueId: string | null
  onSelectIssue: (issue: Issue) => void
  compact: boolean
}) {
  const config = statusConfig[status]
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { status },
  })

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ width: '280px', minWidth: '280px' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 mb-1">
        <span style={{ color: config.color }}>{config.icon}</span>
        <span className="text-xs font-medium">{config.label}</span>
        <span className="text-xs px-1.5 rounded-full bg-surface-hover text-subtle">
          {issues.length}
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
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              isSelected={issue.id === selectedIssueId}
              onClick={() => onSelectIssue(issue)}
              compact={compact}
            />
          ))}
        </SortableContext>
        {issues.length === 0 && (
          <div className="text-center py-8 text-xs text-subtle">
            No issues
          </div>
        )}
      </div>
    </div>
  )
}

export function KanbanView({
  issues,
  selectedIssueId,
  onSelectIssue,
  onMoveIssue,
}: KanbanViewProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [compact, setCompact] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const issuesByStatus = kanbanStatuses.reduce(
    (acc, status) => {
      acc[status] = issues.filter((i) => i.status === status)
      return acc
    },
    {} as Record<Status, Issue[]>
  )

  const activeIssue = activeId
    ? issues.find((i) => i.id === activeId)
    : null

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over) return

    const activeIssueId = active.id as string
    const overId = over.id as string

    // Dropped over a column droppable
    if (overId.startsWith('column-')) {
      const newStatus = over.data.current?.status as Status
      const activeIssueItem = issues.find((i) => i.id === activeIssueId)
      if (activeIssueItem && activeIssueItem.status !== newStatus) {
        onMoveIssue(activeIssueId, newStatus)
      }
      return
    }

    // Dropped over another card
    const overIssue = issues.find((i) => i.id === overId)
    if (overIssue) {
      const activeIssueItem = issues.find((i) => i.id === activeIssueId)
      if (activeIssueItem && activeIssueItem.status !== overIssue.status) {
        onMoveIssue(activeIssueId, overIssue.status)
      }
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)

    if (!over) return

    const activeIssueId = active.id as string
    const overId = over.id as string

    if (overId.startsWith('column-')) {
      const newStatus = over.data.current?.status as Status
      onMoveIssue(activeIssueId, newStatus)
      return
    }

    const overIssue = issues.find((i) => i.id === overId)
    if (overIssue) {
      const activeIssueItem = issues.find((i) => i.id === activeIssueId)
      if (activeIssueItem && activeIssueItem.status !== overIssue.status) {
        onMoveIssue(activeIssueId, overIssue.status)
      }
    }
  }

  return (
    <div className="flex flex-col h-full p-2">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <button
          className={`px-2 py-1 rounded text-xs transition-colors border border-border ${
            compact ? 'bg-accent text-white' : 'bg-surface text-muted'
          }`}
          onClick={() => setCompact(!compact)}
        >
          {compact ? 'Compact' : 'Default'}
        </button>
        <span className="text-xs text-subtle">
          {issues.length} issues · drag to move
        </span>
      </div>

      <div className="flex flex-1 overflow-x-auto p-4 gap-3 min-h-0">
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
              issues={issuesByStatus[status]}
              selectedIssueId={selectedIssueId}
              onSelectIssue={onSelectIssue}
              compact={compact}
            />
          ))}
          <DragOverlay>
            {activeIssue ? <OverlayCard issue={activeIssue} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}
