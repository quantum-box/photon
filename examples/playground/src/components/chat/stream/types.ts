import type { AppKitConfig } from '../../../app/kitConfig'
import type { Message } from '../ChatMessage'
import type { ToolCall, ToolResult, ToolRuntimeContext, ToolType } from '../tools/types'

export type ChatStreamConfig = AppKitConfig['chat']['stream']

export interface ChatStreamCallbacks {
  onChunk: (text: string) => void
  onDone: () => void
  onError?: (error: Error) => void
  onToolCallStart?: (toolCall: ToolCall) => void
  onToolCallUpdate?: (toolCall: ToolCall) => void
}

export interface ChatStreamRequest {
  prompt: string
  messages: Array<Pick<Message, 'role' | 'content'>>
  threadId?: string
  context?: ToolRuntimeContext
}

export interface BackendToolCallRequest {
  id?: string
  type: ToolType
  name?: string
  args?: Record<string, unknown>
}

export interface BackendToolResultEnvelope {
  toolCallId: string
  status: ToolCall['status']
  result: ToolResult
}

export interface ChatStreamAdapter {
  start: (
    request: ChatStreamRequest,
    callbacks: ChatStreamCallbacks,
    config: ChatStreamConfig
  ) => AbortController
}
