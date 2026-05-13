/**
 * Tool integration types for external tool calls (web search, API calls, etc.)
 */

import type { Issue } from '../../../data/mock'

export type ToolType =
  | 'web_search'
  | 'api_call'
  | 'code_exec'
  | 'issue_search'
  | 'issue_list'
  | 'issue_get'
  | 'issue_create'
  | 'issue_update'
  | 'issue_move'
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled'

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
  cancelled?: boolean
  duration?: number // ms
}

export interface IssueToolRuntime {
  issues: Issue[]
  syncIssue: (issue: Issue) => void
  syncIssues: (issues: Issue[]) => void
}

export interface IssueToolResponse {
  action: 'search' | 'list' | 'get' | 'create' | 'update' | 'move'
  issues: Issue[]
  total: number
  message: string
}

export interface ToolRuntimeContext {
  issueTools?: IssueToolRuntime
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
  execute: (
    args: Record<string, unknown>,
    signal: AbortSignal,
    context?: ToolRuntimeContext
  ) => Promise<ToolResult>
}
