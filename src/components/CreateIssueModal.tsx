import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  type Status,
  type Priority,
  statusConfig,
  priorityConfig,
  mockUsers,
} from '../data/mock'
import type { CreateIssueData } from '../contexts/IssuesContext'

interface CreateIssueModalProps {
  open: boolean
  onClose: () => void
  onCreate: (data: CreateIssueData) => void
}

export function CreateIssueModal({ open, onClose, onCreate }: CreateIssueModalProps) {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<Status>('todo')
  const [priority, setPriority] = useState<Priority>('none')
  const [assignee, setAssignee] = useState('')
  const [description, setDescription] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setTitle('')
      setStatus('todo')
      setPriority('none')
      setAssignee('')
      setDescription('')
      setTimeout(() => titleRef.current?.focus(), 50)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleSubmit = useCallback(() => {
    const trimmed = title.trim()
    if (!trimmed) return
    onCreate({
      title: trimmed,
      status,
      priority,
      assignee: assignee || undefined,
      description: description.trim() || undefined,
    })
    onClose()
  }, [title, status, priority, assignee, description, onCreate, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg shadow-xl"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-color)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            New Issue
          </h2>
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

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Title <span style={{ color: 'var(--priority-urgent)' }}>*</span>
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) handleSubmit()
              }}
              placeholder="Issue title..."
              className="w-full px-3 py-2 rounded text-sm outline-none"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {/* Status & Priority row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
                className="w-full px-3 py-2 rounded text-sm outline-none appearance-none cursor-pointer"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                }}
              >
                {(Object.entries(statusConfig) as [Status, typeof statusConfig[Status]][]).map(
                  ([key, sc]) => (
                    <option key={key} value={key}>
                      {sc.icon} {sc.label}
                    </option>
                  )
                )}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className="w-full px-3 py-2 rounded text-sm outline-none appearance-none cursor-pointer"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                }}
              >
                {(Object.entries(priorityConfig) as [Priority, typeof priorityConfig[Priority]][]).map(
                  ([key, pc]) => (
                    <option key={key} value={key}>
                      {pc.icon} {pc.label}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>

          {/* Assignee */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Assignee
            </label>
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="w-full px-3 py-2 rounded text-sm outline-none appearance-none cursor-pointer"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">Unassigned</option>
              {mockUsers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description..."
              rows={4}
              className="w-full px-3 py-2 rounded text-sm outline-none resize-none"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3 border-t"
          style={{ borderColor: 'var(--border-color)' }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              color: 'var(--text-secondary)',
              background: 'var(--bg-hover)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--border-color)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim()}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              background: title.trim() ? 'var(--accent)' : 'var(--bg-hover)',
              color: title.trim() ? '#fff' : 'var(--text-muted)',
              cursor: title.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Create Issue
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
