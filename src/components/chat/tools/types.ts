/**
 * Tool integration types for external tool calls (web search, API calls, etc.)
 */

export type ToolType = 'web_search' | 'api_call' | 'code_exec'
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error'

export interface ToolCall {
  id: string
  type: ToolType
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  result?: ToolResult
}

export interface ToolResult {
  data: unknown
  error?: string
  duration?: number // ms
}

// Web search specific types
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  favicon?: string
}

export interface WebSearchResponse {
  query: string
  results: WebSearchResult[]
  totalResults?: number
}

// API call specific types
export interface ApiCallResponse {
  endpoint: string
  method: string
  statusCode: number
  body: unknown
  headers?: Record<string, string>
}

// Tool registry entry
export interface ToolDefinition {
  type: ToolType
  name: string
  description: string
  icon: string // SVG path or emoji
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>
}
