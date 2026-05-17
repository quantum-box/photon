import { afterEach, describe, expect, it, vi } from 'vitest'
import { startChatStream } from './startChatStream'
import { backendStreamProtocol } from './backendStream'
import type { ChatStreamConfig } from './types'
import type { ToolCall } from '../tools/types'

const encoder = new TextEncoder()

function sseResponse(frames: string[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame))
      }
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('backend chat stream adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('decodes SSE frames with named JSON events', () => {
    const decoded = backendStreamProtocol.decodeSseEvents(
      'event: message_delta\ndata: {"delta":"Hello"}\n\n'
    )

    expect(decoded.events).toEqual([{ event: 'message_delta', data: { delta: 'Hello' } }])
    expect(decoded.rest).toBe('')
  })

  it('streams backend deltas and reports record tool results through the protocol', async () => {
    const toolUpdates: ToolCall[] = []
    const postedToolResults: unknown[] = []
    let text = ''
    let done = false

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url === '/api/agent/chat/stream') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          context: {
            document: {
              docId: 'doc-1',
              selectedText: 'Selected text',
            },
          },
        })
        return sseResponse([
          'event: message_delta\ndata: {"delta":"Looking up records. "}\n\n',
          'event: tool_call_request\ndata: {"id":"call-1","type":"record_list","args":{"query":"backend","limit":1}}\n\n',
          'event: message_delta\ndata: {"delta":"Done."}\n\n',
          'event: done\ndata: {}\n\n',
        ])
      }

      if (url === '/api/records') {
        return Response.json({
          records: [{
            id: 'record-1',
            identifier: 'PLT-1185',
            title: 'Backend stream adapter',
            description: '',
            status: 'todo',
            priority: 'high',
            assignee: null,
            labels: ['feature'],
            project: 'Client App Kit',
            created_at: '2026-05-14T00:00:00.000Z',
            updated_at: '2026-05-14T00:00:00.000Z',
          }],
          total: 1,
        })
      }

      if (url === '/api/agent/tool-results') {
        postedToolResults.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }

      return new Response('not found', { status: 404 })
    })

    const completion = new Promise<void>((resolve) => {
      startChatStream(
        {
          prompt: 'list backend records',
          messages: [{ role: 'user', content: 'list backend records' }],
          context: {
            documentContext: {
              docId: 'doc-1',
              title: 'Spec doc',
              url: '/documents/doc-1',
              selectedText: 'Selected text',
              relatedRecords: [],
            },
            recordTools: {
              records: [],
              syncRecord: vi.fn(),
              syncRecords: vi.fn(),
            },
          },
        },
        {
          onChunk(chunk) {
            text += chunk
          },
          onDone() {
            done = true
            resolve()
          },
          onToolCallStart(toolCall) {
            toolUpdates.push(toolCall)
          },
          onToolCallUpdate(toolCall) {
            toolUpdates.push(toolCall)
          },
        },
        {
          mode: 'backend',
          transport: 'sse',
          endpoint: '/api/agent/chat/stream',
          toolResultPath: '/api/agent/tool-results',
        } satisfies ChatStreamConfig
      )
    })

    await completion

    expect(done).toBe(true)
    expect(text).toBe('Looking up records. Done.')
    expect(toolUpdates[0]).toMatchObject({ id: 'call-1', type: 'record_list', status: 'running' })
    expect(toolUpdates.at(-1)).toMatchObject({ id: 'call-1', status: 'completed' })
    expect(postedToolResults).toEqual([
      expect.objectContaining({ toolCallId: 'call-1', status: 'completed' }),
    ])
  })

  it('accepts backend-provided tool result events', async () => {
    const toolUpdates: ToolCall[] = []

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      'event: tool_call_result\ndata: {"id":"server-call-1","type":"record_search","name":"Record Search","args":{"query":"PLT"},"result":{"data":{"total":0},"duration":12}}\n\n',
      'event: message_delta\ndata: {"delta":"No matching records."}\n\n',
      'event: done\ndata: {}\n\n',
    ]))

    let text = ''
    await new Promise<void>((resolve) => {
      startChatStream(
        {
          prompt: 'search PLT',
          messages: [{ role: 'user', content: 'search PLT' }],
        },
        {
          onChunk(chunk) {
            text += chunk
          },
          onDone: resolve,
          onToolCallUpdate(toolCall) {
            toolUpdates.push(toolCall)
          },
        },
        {
          mode: 'backend',
          transport: 'sse',
          endpoint: '/api/agent/chat/stream',
        } satisfies ChatStreamConfig
      )
    })

    expect(text).toBe('No matching records.')
    expect(toolUpdates).toEqual([
      expect.objectContaining({
        id: 'server-call-1',
        type: 'record_search',
        status: 'completed',
        result: expect.objectContaining({ duration: 12 }),
      }),
    ])
  })
})
