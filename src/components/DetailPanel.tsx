import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  type Issue,
  type Status,
  type Priority,
  statusConfig,
  priorityConfig,
  mockUsers,
} from '../data/mock'

interface DetailPanelProps {
  issue: Issue | null
  onClose: () => void
  onUpdateIssue?: (issueId: string, field: keyof Issue, value: string) => void
  onDeleteIssue?: (issueId: string) => void
}

export function DetailPanel({ issue, onClose, onUpdateIssue, onDeleteIssue }: DetailPanelProps) {
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  // Reset confirm dialog when issue changes
  useEffect(() => {
    setDeleteConfirm(false)
  }, [issue?.id])

  if (!issue) return null

  const status = statusConfig[issue.status]
  const priority = priorityConfig[issue.priority]

  const handleDelete = () => {
    if (onDeleteIssue) {
      onDeleteIssue(issue.id)
      onClose()
    }
  }

  return (
    <div
      className="flex flex-col h-full border-l"
      style={{
        width: 'var(--detail-width)',
        minWidth: 'var(--detail-width)',
        background: 'var(--bg-sidebar)',
        borderColor: 'var(--border-color)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          {issue.identifier}
        </span>
        <div className="flex items-center gap-1">
          {onDeleteIssue && (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="w-6 h-6 flex items-center justify-center rounded transition-colors text-sm"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-hover)'
                e.currentTarget.style.color = 'var(--priority-urgent)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = ''
                e.currentTarget.style.color = 'var(--text-muted)'
              }}
              title="Delete issue"
            >
              🗑
            </button>
          )}
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded transition-colors text-sm"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Editable Title */}
        {onUpdateIssue ? (
          <EditableTitle
            value={issue.title}
            onCommit={(v) => onUpdateIssue(issue.id, 'title', v)}
          />
        ) : (
          <h2 className="text-base font-semibold mb-4">{issue.title}</h2>
        )}

        {/* Properties */}
        <div className="space-y-3 mb-6">
          <PropertyRow label="Status">
            {onUpdateIssue ? (
              <InlineDropdown
                value={issue.status}
                options={(Object.entries(statusConfig) as [Status, typeof statusConfig[Status]][]).map(
                  ([key, sc]) => ({
                    key,
                    label: sc.label,
                    icon: sc.icon,
                    color: sc.color,
                  })
                )}
                renderValue={(
                  <span className="flex items-center gap-1.5 text-sm">
                    <span style={{ color: status.color }}>{status.icon}</span>
                    {status.label}
                  </span>
                )}
                onSelect={(key) => onUpdateIssue(issue.id, 'status', key)}
              />
            ) : (
              <span className="flex items-center gap-1.5 text-sm">
                <span style={{ color: status.color }}>{status.icon}</span>
                {status.label}
              </span>
            )}
          </PropertyRow>

          <PropertyRow label="Priority">
            {onUpdateIssue ? (
              <InlineDropdown
                value={issue.priority}
                options={(Object.entries(priorityConfig) as [Priority, typeof priorityConfig[Priority]][]).map(
                  ([key, pc]) => ({
                    key,
                    label: pc.label,
                    icon: pc.icon,
                    color: pc.color,
                  })
                )}
                renderValue={(
                  <span className="flex items-center gap-1.5 text-sm">
                    <span style={{ color: priority.color }}>{priority.icon}</span>
                    {priority.label}
                  </span>
                )}
                onSelect={(key) => onUpdateIssue(issue.id, 'priority', key)}
              />
            ) : (
              <span className="flex items-center gap-1.5 text-sm">
                <span style={{ color: priority.color }}>{priority.icon}</span>
                {priority.label}
              </span>
            )}
          </PropertyRow>

          <PropertyRow label="Assignee">
            {onUpdateIssue ? (
              <InlineDropdown
                value={issue.assignee ?? ''}
                options={[
                  { key: '', label: 'Unassigned', icon: '', color: 'var(--text-muted)' },
                  ...mockUsers.map((name) => ({
                    key: name,
                    label: name,
                    icon: name[0],
                    color: 'var(--accent)',
                  })),
                ]}
                renderValue={(
                  <span className="text-sm">
                    {issue.assignee ? (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="w-5 h-5 rounded-full flex items-center justify-center text-xs"
                          style={{ background: 'var(--accent)', color: '#fff' }}
                        >
                          {issue.assignee[0]}
                        </span>
                        {issue.assignee}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>
                    )}
                  </span>
                )}
                onSelect={(key) => onUpdateIssue(issue.id, 'assignee', key)}
              />
            ) : (
              <span className="text-sm">
                {issue.assignee ? (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center text-xs"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      {issue.assignee[0]}
                    </span>
                    {issue.assignee}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>
                )}
              </span>
            )}
          </PropertyRow>

          <PropertyRow label="Project">
            {onUpdateIssue ? (
              <EditableText
                value={issue.project}
                onCommit={(v) => onUpdateIssue(issue.id, 'project', v)}
              />
            ) : (
              <span className="text-sm flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
                {issue.project}
              </span>
            )}
          </PropertyRow>

          <PropertyRow label="Labels">
            {onUpdateIssue ? (
              <EditableLabels
                labels={issue.labels}
                onCommit={(labels) =>
                  onUpdateIssue(issue.id, 'labels', JSON.stringify(labels))
                }
              />
            ) : (
              <div className="flex flex-wrap gap-1">
                {issue.labels.map((label) => (
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
            )}
          </PropertyRow>

          <PropertyRow label="Created">
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {new Date(issue.createdAt).toLocaleDateString('ja-JP')}
            </span>
          </PropertyRow>

          <PropertyRow label="Updated">
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {new Date(issue.updatedAt).toLocaleDateString('ja-JP')}
            </span>
          </PropertyRow>
        </div>

        {/* Description */}
        <div
          className="border-t pt-4"
          style={{ borderColor: 'var(--border-color)' }}
        >
          <h3
            className="text-xs font-medium uppercase tracking-wider mb-2"
            style={{ color: 'var(--text-muted)' }}
          >
            Description
          </h3>
          {onUpdateIssue ? (
            <EditableDescription
              value={issue.description}
              onCommit={(v) => onUpdateIssue(issue.id, 'description', v)}
            />
          ) : (
            <div
              className="text-sm leading-relaxed whitespace-pre-wrap"
              style={{ color: 'var(--text-secondary)' }}
            >
              {issue.description}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <DeleteConfirmDialog
          identifier={issue.identifier}
          title={issue.title}
          onConfirm={handleDelete}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────

function PropertyRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start">
      <span
        className="text-xs w-20 shrink-0 pt-0.5"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function EditableTitle({
  value,
  onCommit,
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setEditValue(value)
  }, [value])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== value) {
      onCommit(trimmed)
    } else {
      setEditValue(value)
    }
  }, [editValue, value, onCommit])

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
        className="w-full text-base font-semibold mb-4 px-1 py-0.5 rounded outline-none"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
        }}
      />
    )
  }

  return (
    <h2
      className="text-base font-semibold mb-4 px-1 py-0.5 -mx-1 rounded cursor-text transition-colors"
      onClick={() => setEditing(true)}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
      title="Click to edit"
    >
      {value}
    </h2>
  )
}

function EditableText({
  value,
  onCommit,
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setEditValue(value)
  }, [value])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    if (editValue.trim() !== value) {
      onCommit(editValue.trim())
    } else {
      setEditValue(value)
    }
  }, [editValue, value, onCommit])

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
        className="w-full text-sm px-1 py-0.5 rounded outline-none"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
        }}
      />
    )
  }

  return (
    <span
      className="text-sm flex items-center gap-1.5 px-1 py-0.5 -mx-1 rounded cursor-text transition-colors"
      onClick={() => setEditing(true)}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
      title="Click to edit"
    >
      <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} />
      {value || <span style={{ color: 'var(--text-muted)' }}>—</span>}
    </span>
  )
}

function InlineDropdown({
  value,
  options,
  renderValue,
  onSelect,
}: {
  value: string
  options: { key: string; label: string; icon: string; color: string }[]
  renderValue: React.ReactNode
  onSelect: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <div
        className="cursor-pointer rounded px-1 py-0.5 -mx-1 transition-colors"
        onClick={() => setOpen(!open)}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = '')}
      >
        {renderValue}
      </div>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-50 rounded-md shadow-lg py-1"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            minWidth: '160px',
            maxHeight: '240px',
            overflowY: 'auto',
          }}
        >
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={() => {
                onSelect(opt.key)
                setOpen(false)
              }}
              className="w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 transition-colors"
              style={{
                color: 'var(--text-primary)',
                background: opt.key === value ? 'var(--bg-hover)' : 'transparent',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => {
                e.currentTarget.style.background =
                  opt.key === value ? 'var(--bg-hover)' : 'transparent'
              }}
            >
              {opt.icon && (
                <span style={{ color: opt.color }}>{opt.icon}</span>
              )}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EditableLabels({
  labels,
  onCommit,
}: {
  labels: string[]
  onCommit: (labels: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const addLabel = useCallback(() => {
    const trimmed = inputValue.trim()
    if (trimmed && !labels.includes(trimmed)) {
      onCommit([...labels, trimmed])
    }
    setInputValue('')
  }, [inputValue, labels, onCommit])

  const removeLabel = useCallback(
    (label: string) => {
      onCommit(labels.filter((l) => l !== label))
    },
    [labels, onCommit]
  )

  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {labels.map((label) => (
          <span
            key={label}
            className="px-1.5 py-0.5 rounded text-xs inline-flex items-center gap-1"
            style={{
              background: 'var(--bg-hover)',
              color: 'var(--text-secondary)',
            }}
          >
            {label}
            <button
              onClick={() => removeLabel(label)}
              className="opacity-50 hover:opacity-100 transition-opacity"
              style={{ fontSize: '10px' }}
            >
              ✕
            </button>
          </span>
        ))}
        {editing ? (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => {
              if (inputValue.trim()) addLabel()
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addLabel()
                e.preventDefault()
              }
              if (e.key === 'Escape') {
                setInputValue('')
                setEditing(false)
              }
            }}
            placeholder="Add label..."
            className="px-1.5 py-0.5 rounded text-xs outline-none"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--accent)',
              color: 'var(--text-primary)',
              width: '80px',
            }}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="px-1.5 py-0.5 rounded text-xs transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)'
              e.currentTarget.style.color = 'var(--text-secondary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = ''
              e.currentTarget.style.color = 'var(--text-muted)'
            }}
          >
            + Add
          </button>
        )}
      </div>
    </div>
  )
}

function EditableDescription({
  value,
  onCommit,
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setEditValue(value)
  }, [value])

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      // Auto-resize
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    if (editValue !== value) {
      onCommit(editValue)
    }
  }, [editValue, value, onCommit])

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={editValue}
        onChange={(e) => {
          setEditValue(e.target.value)
          // Auto-resize on input
          e.target.style.height = 'auto'
          e.target.style.height = e.target.scrollHeight + 'px'
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setEditValue(value)
            setEditing(false)
          }
        }}
        className="w-full text-sm leading-relaxed px-2 py-1.5 rounded outline-none resize-none"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
          minHeight: '80px',
        }}
      />
    )
  }

  return (
    <div
      className="text-sm leading-relaxed whitespace-pre-wrap px-2 py-1.5 -mx-2 rounded cursor-text transition-colors"
      style={{ color: 'var(--text-secondary)', minHeight: '40px' }}
      onClick={() => setEditing(true)}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
      title="Click to edit"
    >
      {value || <span style={{ color: 'var(--text-muted)' }}>Add a description...</span>}
    </div>
  )
}

function DeleteConfirmDialog({
  identifier,
  title,
  onConfirm,
  onCancel,
}: {
  identifier: string
  title: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="w-full max-w-sm rounded-lg shadow-xl p-5"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
        }}
      >
        <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          Delete {identifier}?
        </h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
          <span className="font-medium">{title}</span> will be permanently deleted. This action cannot be undone.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--border-color)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{ background: 'var(--priority-urgent)', color: '#fff' }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
