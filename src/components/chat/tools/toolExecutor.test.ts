import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeTool,
  generateToolCallId,
  getAllTools,
  getTool,
} from './toolExecutor'
import type { RecordToolResponse, WebSearchResponse } from './types'
import type { DatabaseRecord } from '../../../data/mock'

describe('tool executor', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('registers the built-in tool definitions', () => {
    expect(getTool('web_search')?.name).toBe('Web Search')
    expect(getTool('api_call')?.name).toBe('API Call')
    expect(getTool('code_exec')?.name).toBe('Code Execution')
    expect(getAllTools().map((tool) => tool.type)).toEqual(expect.arrayContaining([
      'web_search',
      'api_call',
      'code_exec',
      'record_search',
      'record_list',
      'record_get',
      'record_create',
      'record_update',
      'record_move',
    ]))
    expect(getAllTools()).toHaveLength(9)
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

  it('creates records through Photon Engine and syncs the projection', async () => {
    const synced: DatabaseRecord[] = []
    const title = `Created from chat ${Date.now()}`

    const result = await executeTool(
      'record_create',
      { title, priority: 'high', labels: ['chat'], project: 'Photon Core' },
      new AbortController().signal,
      {
        recordTools: {
          records: [],
          syncRecord: (record) => synced.push(record),
          syncRecords: () => {},
        },
      }
    )

    const data = result.data as RecordToolResponse
    expect(result.error).toBeUndefined()
    expect(data.action).toBe('create')
    expect(data.records[0]).toMatchObject({ title, priority: 'high', labels: ['chat'] })
    expect(synced).toHaveLength(1)
  })

  it('searches canonical Photon Engine records and syncs fetched results', async () => {
    const syncedLists: DatabaseRecord[][] = []
    const title = `Investigate blocker ${Date.now()}`

    await executeTool(
      'record_create',
      {
        title,
        description: 'A release blocker',
        status: 'in_progress',
        priority: 'urgent',
        assignee: 'Alice',
        labels: ['blocker'],
        project: 'Photon Core',
      },
      new AbortController().signal,
      {
        recordTools: {
          records: [],
          syncRecord: () => {},
          syncRecords: () => {},
        },
      }
    )

    const result = await executeTool(
      'record_search',
      { query: title },
      new AbortController().signal,
      {
        recordTools: {
          records: [],
          syncRecord: () => {},
          syncRecords: (records) => syncedLists.push(records),
        },
      }
    )

    const data = result.data as RecordToolResponse
    expect(data.total).toBe(1)
    expect(data.records[0]).toMatchObject({ title, assignee: 'Alice', labels: ['blocker'] })
    expect(syncedLists[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ title }),
    ]))
  })
})
