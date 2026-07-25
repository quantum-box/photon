import { memo, useState } from 'react'
import type { ToolCall, ApiCallResponse, RecordToolResponse } from './types'
import { statusConfig, priorityConfig } from '../../../data/mock'
import { WebSearchCard } from './WebSearchCard'

// --- Icons ---

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transition: 'transform 150ms',
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
    }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const ApiIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 11a9 9 0 0 1 9-9" />
    <path d="M4 4v7h7" />
    <path d="M20 13a9 9 0 0 1-9 9" />
    <path d="M20 20v-7h-7" />
  </svg>
)

const CodeIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
)

const RecordIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M9 12l2 2 4-5" />
  </svg>
)

function ToolStatus({ toolCall, loadingText }: { toolCall: ToolCall; loadingText: string }) {
  const isLoading = toolCall.status === 'pending' || toolCall.status === 'running'
  if (isLoading) {
    return (
      <span className="flex items-center gap-1.5">
        <div className="tool-spinner" />
        <span className="text-xs text-subtle">{loadingText}</span>
      </span>
    )
  }
  if (toolCall.status === 'cancelled') {
    return <span className="text-xs text-subtle">Cancelled</span>
  }
  if (toolCall.status === 'error') {
    return <span className="text-xs text-priority-urgent">Failed</span>
  }
  if (toolCall.result?.duration) {
    return <span className="text-xs text-subtle">{(toolCall.result.duration / 1000).toFixed(1)}s</span>
  }
  return null
}

// --- API Call Card ---

function ApiCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const isLoading = toolCall.status === 'pending' || toolCall.status === 'running'
  const response = toolCall.result?.data as ApiCallResponse | undefined

  return (
    <div className="my-2 rounded-xl overflow-hidden border border-border bg-surface">
      <button
        onClick={() => !isLoading && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-hover transition-colors"
      >
        <span className="text-accent">{ApiIcon}</span>
        <span className="text-xs font-medium flex-1 text-left text-foreground">
          API Call
        </span>

        {response && (
          <span className="flex items-center gap-1.5">
            <span
              className="text-xs px-1.5 py-0.5 rounded font-mono"
              style={{
                background: response.statusCode < 400 ? 'rgba(52,199,89,0.15)' : 'rgba(255,59,48,0.15)',
                color: response.statusCode < 400 ? 'var(--status-done)' : 'var(--priority-urgent)',
              }}
            >
              {response.statusCode}
            </span>
            <span className="text-xs font-mono text-subtle">
              {response.method} {response.endpoint}
            </span>
          </span>
        )}

        <ToolStatus toolCall={toolCall} loadingText="Calling..." />

        {!isLoading && <ChevronIcon open={expanded} />}
      </button>

      {expanded && response && (
        <div className="px-3 py-2 text-xs font-mono overflow-x-auto border-t border-border bg-code text-foreground">
          <pre className="whitespace-pre-wrap">{JSON.stringify(response.body, null, 2)}</pre>
        </div>
      )}

      {toolCall.status === 'error' && (
        <div className="px-3 py-2 text-xs text-subtle border-t border-border">
          {toolCall.result?.error || 'API call failed'}
        </div>
      )}
    </div>
  )
}

// --- Code Execution Card ---

function CodeExecCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const isLoading = toolCall.status === 'pending' || toolCall.status === 'running'
  const result = toolCall.result?.data as { code: string; output: string; exitCode: number } | undefined

  return (
    <div className="my-2 rounded-xl overflow-hidden border border-border bg-surface">
      <button
        onClick={() => !isLoading && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-hover transition-colors"
      >
        <span className="text-accent">{CodeIcon}</span>
        <span className="text-xs font-medium flex-1 text-left text-foreground">
          Code Execution
        </span>

        {result && (
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{
              background: result.exitCode === 0 ? 'rgba(52,199,89,0.15)' : 'rgba(255,59,48,0.15)',
              color: result.exitCode === 0 ? 'var(--status-done)' : 'var(--priority-urgent)',
            }}
          >
            exit {result.exitCode}
          </span>
        )}

        <ToolStatus toolCall={toolCall} loadingText="Executing..." />

        {!isLoading && <ChevronIcon open={expanded} />}
      </button>

      {expanded && result && (
        <div className="px-3 py-2 text-xs font-mono overflow-x-auto border-t border-border bg-code text-foreground">
          <pre className="whitespace-pre-wrap">{result.output}</pre>
        </div>
      )}

      {toolCall.status === 'error' && (
        <div className="px-3 py-2 text-xs text-subtle border-t border-border">
          {toolCall.result?.error || 'Code execution failed'}
        </div>
      )}
    </div>
  )
}

// --- DatabaseRecord Tool Card ---

function RecordToolCard({ toolCall }: { toolCall: ToolCall }) {
  const result = toolCall.result?.data as RecordToolResponse | undefined
  const isLoading = toolCall.status === 'pending' || toolCall.status === 'running'
  const actionLabel = toolCall.name

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-surface" data-testid="record-tool-result">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="shrink-0 text-accent">{RecordIcon}</span>
        <span className="min-w-0 flex-1 text-left text-xs font-medium text-foreground">
          {actionLabel}
        </span>
        {result && toolCall.status === 'completed' && (
          <span className="text-xs text-status-done">
            {result.message}
            {toolCall.result?.duration && ` · ${(toolCall.result.duration / 1000).toFixed(1)}s`}
          </span>
        )}
        <ToolStatus toolCall={toolCall} loadingText="Updating..." />
      </div>

      {isLoading && (
        <div className="px-3 py-3 text-xs text-subtle">
          Reading the database record store...
        </div>
      )}

      {toolCall.status === 'completed' && result && (
        <div className="divide-y divide-border">
          {result.records.length === 0 ? (
            <div className="px-3 py-3 text-xs text-subtle">No matching records.</div>
          ) : (
            result.records.map((record) => {
              const status = statusConfig[record.status]
              const priority = priorityConfig[record.priority]
              return (
                <div key={record.id} className="px-3 py-2.5">
                  <div className="mb-1 flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-[10px] text-subtle">
                      {record.identifier}
                    </span>
                    <span className="truncate text-sm font-medium text-foreground">
                      {record.title}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="inline-flex items-center gap-1" style={{ color: status.color }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.color }} />
                      {status.label}
                    </span>
                    <span style={{ color: priority.color }}>{priority.icon} {priority.label}</span>
                    {record.assignee && <span>{record.assignee}</span>}
                    {record.labels.slice(0, 3).map((label) => (
                      <span key={label} className="rounded bg-canvas px-1.5 py-0.5 text-subtle">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {(toolCall.status === 'error' || toolCall.status === 'cancelled') && (
        <div className="px-3 py-3 text-xs text-subtle">
          {toolCall.result?.error || 'Database tool did not complete.'}
        </div>
      )}
    </div>
  )
}

// --- Generic ToolResultCard dispatcher ---

interface ToolResultCardProps {
  toolCall: ToolCall
}

export const ToolResultCard = memo(function ToolResultCard({ toolCall }: ToolResultCardProps) {
  switch (toolCall.type) {
    case 'web_search':
      return <WebSearchCard toolCall={toolCall} />
    case 'api_call':
      return <ApiCallCard toolCall={toolCall} />
    case 'code_exec':
      return <CodeExecCard toolCall={toolCall} />
    case 'record_search':
    case 'record_list':
    case 'record_get':
    case 'record_create':
    case 'record_update':
    case 'record_move':
      return <RecordToolCard toolCall={toolCall} />
    default:
      return (
        <div className="my-2 px-3 py-2 rounded-xl text-xs border border-border text-subtle">
          Unknown tool: {toolCall.type}
        </div>
      )
  }
})
