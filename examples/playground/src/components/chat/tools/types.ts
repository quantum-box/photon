/**
 * Tool integration types for external tool calls (web search, API calls, etc.)
 */

import type { DatabaseRecord } from '../../../data/mock'
import type { WorkspaceDocContext } from '../../../lib/docs/workspaceContext'

export type ToolType =
  | 'web_search'
  | 'api_call'
  | 'code_exec'
  | 'record_search'
  | 'record_list'
  | 'record_get'
  | 'record_create'
  | 'record_update'
  | 'record_move'
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

export interface RecordToolRuntime {
  records: DatabaseRecord[]
}

export interface RecordToolResponse {
  action: 'search' | 'list' | 'get' | 'create' | 'update' | 'move'
  records: DatabaseRecord[]
  total: number
  message: string
}

export interface ToolRuntimeContext {
  recordTools?: RecordToolRuntime
  documentContext?: WorkspaceDocContext | null
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
