import type {
  BackendToolCallRequest,
  BackendToolResultEnvelope,
  ChatStreamAdapter,
  ChatStreamCallbacks,
  ChatStreamConfig,
  ChatStreamRequest,
} from './types'
import type { ToolCall, ToolResult } from '../tools/types'
import { executeTool, generateToolCallId, getTool } from '../tools/toolExecutor'

interface StreamEvent {
  event: string
  data: unknown
}

type ToolResultSink = (envelope: BackendToolResultEnvelope) => Promise<void>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function decodeSseEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const frames = normalized.split('\n\n')
  const rest = frames.pop() ?? ''

  for (const frame of frames) {
    let event = 'message'
    const dataLines: string[] = []

    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }

    const rawData = dataLines.join('\n')
    if (!rawData) {
      events.push({ event, data: null })
      continue
    }

    try {
      events.push({ event, data: JSON.parse(rawData) })
    } catch {
      events.push({ event, data: rawData })
    }
  }

  return { events, rest }
}

function normalizeToolRequest(data: unknown): BackendToolCallRequest | undefined {
  const record = asRecord(data)
  const type = asText(record.type ?? record.tool)
  if (!type) return undefined
  return {
    id: asText(record.id ?? record.toolCallId),
    type: type as BackendToolCallRequest['type'],
    name: asText(record.name),
    args: asRecord(record.args ?? record.arguments),
  }
}

function toolCallName(request: BackendToolCallRequest) {
  return request.name ?? getTool(request.type)?.name ?? request.type
}

async function runRequestedTool(
  request: BackendToolCallRequest,
  signal: AbortSignal,
  callbacks: ChatStreamCallbacks,
  chatRequest: ChatStreamRequest,
  sink: ToolResultSink
) {
  const toolCall: ToolCall = {
    id: request.id ?? generateToolCallId(),
    type: request.type,
    name: toolCallName(request),
    args: request.args ?? {},
    status: 'running',
  }

  callbacks.onToolCallStart?.(toolCall)

  const result = await executeTool(request.type, toolCall.args, signal, chatRequest.context)
  const status: ToolCall['status'] = result.cancelled ? 'cancelled' : result.error ? 'error' : 'completed'
  const updated: ToolCall = { ...toolCall, status, result }

  callbacks.onToolCallUpdate?.(updated)
  await sink({ toolCallId: toolCall.id, status, result })
}

async function postToolResult(
  envelope: BackendToolResultEnvelope,
  config: ChatStreamConfig,
  signal: AbortSignal
) {
  if (!config.toolResultPath) return

  const headers: HeadersInit = { 'content-type': 'application/json' }
  if (config.authToken) headers.authorization = `Bearer ${config.authToken}`

  await fetch(config.toolResultPath, {
    method: 'POST',
    headers,
    body: JSON.stringify(envelope),
    signal,
  })
}

function handleBackendEvent(
  event: StreamEvent,
  callbacks: ChatStreamCallbacks,
  chatRequest: ChatStreamRequest,
  signal: AbortSignal,
  sink: ToolResultSink,
  pendingTools?: Promise<void>[]
) {
  const { event: eventName, data } = event
  const record = asRecord(data)

  if (eventName === 'done' || eventName === 'end') {
    callbacks.onDone()
    return
  }

  if (eventName === 'error') {
    callbacks.onError?.(new Error(asText(record.message) ?? asText(data) ?? 'Chat stream failed'))
    callbacks.onDone()
    return
  }

  if (eventName === 'tool_call_cancel' || eventName === 'tool_cancel') {
    const request = normalizeToolRequest(data)
    if (!request?.id) return
    const result: ToolResult = {
      data: null,
      error: asText(record.reason) ?? 'Tool call was cancelled',
      cancelled: true,
    }
    callbacks.onToolCallUpdate?.({
      id: request.id,
      type: request.type,
      name: toolCallName(request),
      args: request.args ?? {},
      status: 'cancelled',
      result,
    })
    return
  }

  if (eventName === 'tool_call_result' || eventName === 'tool_result') {
    const request = normalizeToolRequest(data)
    if (!request?.id) return
    const resultRecord = asRecord(record.result)
    const result: ToolResult = 'data' in resultRecord || 'error' in resultRecord
      ? {
          data: resultRecord.data,
          error: asText(resultRecord.error),
          cancelled: Boolean(resultRecord.cancelled) || undefined,
          duration: typeof resultRecord.duration === 'number' ? resultRecord.duration : undefined,
        }
      : { data: record.result ?? record.data ?? null, error: asText(record.error) }
    callbacks.onToolCallUpdate?.({
      id: request.id,
      type: request.type,
      name: toolCallName(request),
      args: request.args ?? {},
      status: result.cancelled ? 'cancelled' : result.error ? 'error' : 'completed',
      result,
    })
    return
  }

  if (eventName === 'tool_call_error' || eventName === 'tool_error') {
    const request = normalizeToolRequest(data)
    if (!request?.id) return
    callbacks.onToolCallUpdate?.({
      id: request.id,
      type: request.type,
      name: toolCallName(request),
      args: request.args ?? {},
      status: 'error',
      result: { data: null, error: asText(record.error) ?? 'Tool call failed' },
    })
    return
  }

  if (eventName === 'tool_call_request' || eventName === 'tool_call') {
    const request = normalizeToolRequest(data)
    if (!request) return
    const pending = runRequestedTool(request, signal, callbacks, chatRequest, sink).catch((err: unknown) => {
      callbacks.onError?.(new Error(String(err)))
    })
    pendingTools?.push(pending)
    return
  }

  const text = asText(record.delta ?? record.chunk ?? record.content ?? data)
  if (text) callbacks.onChunk(text)
}

async function startSseFetch(
  chatRequest: ChatStreamRequest,
  callbacks: ChatStreamCallbacks,
  config: ChatStreamConfig,
  controller: AbortController
) {
  const headers: HeadersInit = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
  }
  if (config.authToken) headers.authorization = `Bearer ${config.authToken}`

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: chatRequest.prompt,
      messages: chatRequest.messages,
      tools: ['issue_search', 'issue_list', 'issue_get', 'issue_create', 'issue_update', 'issue_move'],
    }),
    signal: controller.signal,
  })

  if (!response.ok) throw new Error(`Chat stream failed with HTTP ${response.status}`)
  if (!response.body) throw new Error('Chat stream response did not include a body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  const pendingTools: Promise<void>[] = []

  try {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const decoded = decodeSseEvents(buffer)
      buffer = decoded.rest
      for (const event of decoded.events) {
        if (event.event === 'done' || event.event === 'end') {
          await Promise.all(pendingTools)
          callbacks.onDone()
          completed = true
          continue
        }

        handleBackendEvent(
          event,
          callbacks,
          chatRequest,
          controller.signal,
          (envelope) => postToolResult(envelope, config, controller.signal),
          pendingTools
        )
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!controller.signal.aborted && !completed) {
    await Promise.all(pendingTools)
    callbacks.onDone()
  }
}

function startWebSocket(
  chatRequest: ChatStreamRequest,
  callbacks: ChatStreamCallbacks,
  config: ChatStreamConfig,
  controller: AbortController
) {
  const url = config.websocketUrl ?? config.endpoint
  const socket = new WebSocket(url)

  controller.signal.addEventListener('abort', () => {
    socket.close(1000, 'client aborted')
  })

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      type: 'chat_request',
      prompt: chatRequest.prompt,
      messages: chatRequest.messages,
    }))
  })

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data)) as { event?: string; type?: string; data?: unknown }
    handleBackendEvent(
      { event: payload.event ?? payload.type ?? 'message', data: payload.data ?? payload },
      callbacks,
      chatRequest,
      controller.signal,
      async (envelope) => {
        socket.send(JSON.stringify({ type: 'tool_call_result', ...envelope }))
      }
    )
  })

  socket.addEventListener('error', () => {
    callbacks.onError?.(new Error('Chat WebSocket stream failed'))
    callbacks.onDone()
  })

  socket.addEventListener('close', () => {
    if (!controller.signal.aborted) callbacks.onDone()
  })
}

export const backendStreamAdapter: ChatStreamAdapter = {
  start(chatRequest, callbacks, config) {
    const controller = new AbortController()

    if (config.transport === 'websocket') {
      startWebSocket(chatRequest, callbacks, config, controller)
      return controller
    }

    void startSseFetch(chatRequest, callbacks, config, controller).catch((err: unknown) => {
      if (controller.signal.aborted) return
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
      callbacks.onDone()
    })

    return controller
  },
}

export const backendStreamProtocol = {
  decodeSseEvents,
  normalizeToolRequest,
}
