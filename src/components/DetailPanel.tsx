import {
  type Issue,
  statusConfig,
  priorityConfig,
} from '../data/mock'

interface DetailPanelProps {
  issue: Issue | null
  onClose: () => void
}

export function DetailPanel({ issue, onClose }: DetailPanelProps) {
  if (!issue) return null

  const status = statusConfig[issue.status]
  const priority = priorityConfig[issue.priority]

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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <h2 className="text-base font-semibold mb-4">{issue.title}</h2>

        {/* Properties */}
        <div className="space-y-3 mb-6">
          <PropertyRow label="Status">
            <span className="flex items-center gap-1.5 text-sm">
              <span style={{ color: status.color }}>{status.icon}</span>
              {status.label}
            </span>
          </PropertyRow>

          <PropertyRow label="Priority">
            <span className="flex items-center gap-1.5 text-sm">
              <span style={{ color: priority.color }}>{priority.icon}</span>
              {priority.label}
            </span>
          </PropertyRow>

          <PropertyRow label="Assignee">
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
          </PropertyRow>

          <PropertyRow label="Project">
            <span className="text-sm flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: 'var(--accent)' }}
              />
              {issue.project}
            </span>
          </PropertyRow>

          <PropertyRow label="Labels">
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
          <div
            className="text-sm leading-relaxed whitespace-pre-wrap"
            style={{ color: 'var(--text-secondary)' }}
          >
            {issue.description}
          </div>
        </div>
      </div>
    </div>
  )
}

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
