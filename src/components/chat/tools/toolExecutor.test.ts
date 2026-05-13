import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeTool,
  generateToolCallId,
  getAllTools,
  getTool,
} from './toolExecutor'
import type { IssueToolResponse, WebSearchResponse } from './types'
import type { Issue } from '../../../data/mock'

describe('tool executor', () => {
  afterEach(() => {
    vi.useRealTimers()
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
      'issue_search',
      'issue_list',
      'issue_get',
      'issue_create',
      'issue_update',
      'issue_move',
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

  it('creates issues through the server-backed issue API and syncs the projection', async () => {
    const synced: Issue[] = []
    const serverIssue: Issue = {
      id: 'issue-1',
      identifier: 'PLT-101',
      title: 'Created from chat',
      status: 'todo',
      priority: 'high',
      assignee: null,
      labels: ['chat'],
      project: 'Photon Core',
      createdAt: '2026-05-14T00:00:00Z',
      updatedAt: '2026-05-14T00:00:00Z',
      description: '',
    }

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        ...serverIssue,
        created_at: serverIssue.createdAt,
        updated_at: serverIssue.updatedAt,
      }),
    })))

    const result = await executeTool(
      'issue_create',
      { title: 'Created from chat', priority: 'high', labels: ['chat'], project: 'Photon Core' },
      new AbortController().signal,
      {
        issueTools: {
          issues: [],
          syncIssue: (issue) => synced.push(issue),
          syncIssues: () => {},
        },
      }
    )

    const data = result.data as IssueToolResponse
    expect(result.error).toBeUndefined()
    expect(data.action).toBe('create')
    expect(data.issues[0]).toMatchObject({ identifier: 'PLT-101', title: 'Created from chat' })
    expect(synced).toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith('/api/issues', expect.objectContaining({ method: 'POST' }))
  })

  it('searches the canonical issue list and syncs fetched results', async () => {
    const issue: Issue = {
      id: 'issue-2',
      identifier: 'PLT-102',
      title: 'Investigate blocker',
      status: 'in_progress',
      priority: 'urgent',
      assignee: 'Alice',
      labels: ['blocker'],
      project: 'Photon Core',
      createdAt: '2026-05-14T00:00:00Z',
      updatedAt: '2026-05-14T00:00:00Z',
      description: 'A release blocker',
    }
    const syncedLists: Issue[][] = []

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          {
            ...issue,
            created_at: issue.createdAt,
            updated_at: issue.updatedAt,
          },
        ],
        total: 1,
      }),
    })))

    const result = await executeTool(
      'issue_search',
      { query: 'blocker' },
      new AbortController().signal,
      {
        issueTools: {
          issues: [],
          syncIssue: () => {},
          syncIssues: (issues) => syncedLists.push(issues),
        },
      }
    )

    const data = result.data as IssueToolResponse
    expect(data.total).toBe(1)
    expect(data.issues[0].identifier).toBe('PLT-102')
    expect(syncedLists[0]).toHaveLength(1)
  })
})
