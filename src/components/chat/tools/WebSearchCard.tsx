import { memo } from 'react'
import type { ToolCall, WebSearchResponse, WebSearchResult } from './types'

function SearchResultItem({ result }: { result: WebSearchResult }) {
  // Extract domain from URL for display
  let domain = ''
  try {
    domain = new URL(result.url).hostname.replace('www.', '')
  } catch {
    domain = result.url
  }

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block px-3 py-2.5 transition-colors rounded-lg hover:bg-surface-hover"
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold flex-shrink-0 bg-surface-hover text-subtle">
          {domain.charAt(0).toUpperCase()}
        </div>
        <span className="text-xs truncate text-subtle">
          {domain}
        </span>
      </div>
      <div className="text-sm font-medium mb-0.5 line-clamp-1 hover:underline text-accent">
        {result.title}
      </div>
      <p className="text-xs line-clamp-2 leading-relaxed text-muted">
        {result.snippet}
      </p>
    </a>
  )
}

function SearchSkeleton() {
  return (
    <div className="px-3 py-2.5 space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded shimmer bg-surface-hover" />
            <div className="h-3 w-24 rounded shimmer bg-surface-hover" />
          </div>
          <div className="h-4 w-3/4 rounded shimmer bg-surface-hover" />
          <div className="h-3 w-full rounded shimmer bg-surface-hover" />
        </div>
      ))}
    </div>
  )
}

interface WebSearchCardProps {
  toolCall: ToolCall
}

export const WebSearchCard = memo(function WebSearchCard({ toolCall }: WebSearchCardProps) {
  const isLoading = toolCall.status === 'pending' || toolCall.status === 'running'
  const isError = toolCall.status === 'error'
  const query = String(toolCall.args.query || '')
  const response = toolCall.result?.data as WebSearchResponse | undefined

  return (
    <div className="my-2 rounded-xl overflow-hidden border border-border bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent flex-shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span className="text-xs font-medium text-foreground">
            Web Search
          </span>
          {query && (
            <span className="text-xs truncate px-1.5 py-0.5 rounded text-muted bg-surface-hover">
              "{query}"
            </span>
          )}
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isLoading && (
            <>
              <div className="tool-spinner" />
              <span className="text-xs text-subtle">Searching…</span>
            </>
          )}
          {toolCall.status === 'completed' && response && (
            <span className="text-xs text-status-done">
              {response.results.length} results
              {toolCall.result?.duration && ` · ${(toolCall.result.duration / 1000).toFixed(1)}s`}
            </span>
          )}
          {isError && (
            <span className="text-xs text-priority-urgent">
              {toolCall.result?.error || 'Search failed'}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      {isLoading && <SearchSkeleton />}

      {toolCall.status === 'completed' && response && (
        <div className="divide-y divide-border">
          {response.results.map((result, idx) => (
            <SearchResultItem key={idx} result={result} />
          ))}
        </div>
      )}

      {isError && (
        <div className="px-3 py-3 text-xs text-subtle">
          Could not complete the search. Please try again.
        </div>
      )}
    </div>
  )
})
