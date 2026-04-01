import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
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

const kanbanStatuses: Status[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']

function KanbanCard({
  issue,
  isSelected,
  onClick,
}: {
  issue: Issue
  isSelected: boolean
  onClick: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background: isSelected ? 'var(--bg-hover)' : 'var(--bg-surface)',
    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border-color)'}`,
  }

  const priority = priorityConfig[issue.priority]

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="rounded-md p-3 mb-2 cursor-grab active:cursor-grabbing transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick() }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
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
              className="px-1.5 py-0.5 rounded text-xs"
              style={{
                background: 'var(--bg-primary)',
                color: 'var(--text-muted)',
              }}
            >
              {label}
            </span>
          ))}
        </div>
        {issue.assignee && (
          <span
            className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
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
      className="rounded-md p-3 cursor-grabbing shadow-xl"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--accent)',
        width: '260px',
      }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
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
}: {
  status: Status
  issues: Issue[]
  selectedIssueId: string | null
  onSelectIssue: (issue: Issue) => void
}) {
  const config = statusConfig[status]

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ width: '280px', minWidth: '280px' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 mb-2">
        <span style={{ color: config.color }}>{config.icon}</span>
        <span className="text-sm font-medium">{config.label}</span>
        <span
          className="text-xs px-1.5 rounded-full"
          style={{
            background: 'var(--bg-hover)',
            color: 'var(--text-muted)',
          }}
        >
          {issues.length}
        </span>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-4"
        style={{ minHeight: '200px' }}
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
            />
          ))}
        </SortableContext>
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

  const activeIssue = activeId ? issues.find((i) => i.id === activeId) : null

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)

    if (!over) return

    const activeIssueId = active.id as string
    const overId = over.id as string

    const overIssue = issues.find((i) => i.id === overId)
    if (overIssue) {
      const activeIssueItem = issues.find((i) => i.id === activeIssueId)
      if (activeIssueItem && activeIssueItem.status !== overIssue.status) {
        onMoveIssue(activeIssueId, overIssue.status)
      }
    }
  }

  return (
    <div className="flex h-full overflow-x-auto p-4 gap-3">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {kanbanStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={issuesByStatus[status]}
            selectedIssueId={selectedIssueId}
            onSelectIssue={onSelectIssue}
          />
        ))}
        <DragOverlay>
          {activeIssue ? <OverlayCard issue={activeIssue} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
