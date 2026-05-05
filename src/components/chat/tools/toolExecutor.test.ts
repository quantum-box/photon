import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeTool,
  generateToolCallId,
  getAllTools,
  getTool,
} from './toolExecutor'
import type { WebSearchResponse } from './types'

describe('tool executor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers the built-in tool definitions', () => {
    expect(getTool('web_search')?.name).toBe('Web Search')
    expect(getTool('api_call')?.name).toBe('API Call')
    expect(getTool('code_exec')?.name).toBe('Code Execution')
    expect(getAllTools().map((tool) => tool.type)).toEqual([
      'web_search',
      'api_call',
      'code_exec',
    ])
  })

  it('generates stable incremental tool call ids', () => {
    const first = generateToolCallId()
    const second = generateToolCallId()

    expect(first).toMatch(/^tool-\d+$/)
    expect(second).toMatch(/^tool-\d+$/)
    expect(Number(second.replace('tool-', ''))).toBe(Number(first.replace('tool-', '')) + 1)
  })

  it('executes web search with query-specific mock results', async () => {
    vi.useFakeTimers()

    const resultPromise = executeTool(
      'web_search',
      { query: 'tailwind css upgrade' },
      new AbortController().signal
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise
    const data = result.data as WebSearchResponse

    expect(result.error).toBeUndefined()
    expect(data.query).toBe('tailwind css upgrade')
    expect(data.results[0].title).toContain('Tailwind CSS')
  })

  it('returns a useful error for unknown tools and cancelled work', async () => {
    const unknown = await executeTool(
      'missing_tool' as never,
      {},
      new AbortController().signal
    )
    expect(unknown.error).toBe('Unknown tool type: missing_tool')

    vi.useFakeTimers()
    const controller = new AbortController()
    const resultPromise = executeTool('code_exec', { code: '1 + 1' }, controller.signal)
    controller.abort()
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toMatchObject({
      data: null,
      error: 'Tool execution was cancelled',
    })
  })
})
