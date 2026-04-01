import { memo, useState } from 'react'
import type { ToolCall, ApiCallResponse } from './types'
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

// --- API Call Card ---

function ApiCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const isLoading = toolCall.status === 'pending' || toolCall.status === 'running'
  const response = toolCall.result?.data as ApiCallResponse | undefined

  return (
    <div
      className="my-2 rounded-xl overflow-hidden"
      style={{ border: '1px solid var(--border-color)', background: 'var(--bg-surface)' }}
    >
      <button
        onClick={() => !isLoading && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
      >
        <span style={{ color: 'var(--accent)' }}>{ApiIcon}</span>
        <span className="text-xs font-medium flex-1 text-left" style={{ color: 'var(--text-primary)' }}>
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
            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              {response.method} {response.endpoint}
            </span>
          </span>
        )}

        {isLoading && (
          <span className="flex items-center gap-1.5">
            <div className="tool-spinner" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Calling…</span>
          </span>
        )}

        {toolCall.result?.duration && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {(toolCall.result.duration / 1000).toFixed(1)}s
          </span>
        )}

        {!isLoading && <ChevronIcon open={expanded} />}
      </button>

      {expanded && response && (
        <div
          className="px-3 py-2 text-xs font-mono overflow-x-auto"
          style={{
            borderTop: '1px solid var(--border-color)',
            background: '#1a1a2e',
            color: 'var(--text-primary)',
          }}
        >
          <pre className="whitespace-pre-wrap">{JSON.stringify(response.body, null, 2)}</pre>
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
    <div
      className="my-2 rounded-xl overflow-hidden"
      style={{ border: '1px solid var(--border-color)', background: 'var(--bg-surface)' }}
    >
      <button
        onClick={() => !isLoading && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
      >
        <span style={{ color: 'var(--accent)' }}>{CodeIcon}</span>
        <span className="text-xs font-medium flex-1 text-left" style={{ color: 'var(--text-primary)' }}>
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

        {isLoading && (
          <span className="flex items-center gap-1.5">
            <div className="tool-spinner" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Executing…</span>
          </span>
        )}

        {toolCall.result?.duration && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {(toolCall.result.duration / 1000).toFixed(1)}s
          </span>
        )}

        {!isLoading && <ChevronIcon open={expanded} />}
      </button>

      {expanded && result && (
        <div
          className="px-3 py-2 text-xs font-mono overflow-x-auto"
          style={{
            borderTop: '1px solid var(--border-color)',
            background: '#1a1a2e',
            color: 'var(--text-primary)',
          }}
        >
          <pre className="whitespace-pre-wrap">{result.output}</pre>
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
    default:
      return (
        <div
          className="my-2 px-3 py-2 rounded-xl text-xs"
          style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
        >
          Unknown tool: {toolCall.type}
        </div>
      )
  }
})
