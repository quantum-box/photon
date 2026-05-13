/**
 * Tool execution framework.
 * Registry-based system for registering and executing external tools.
 */

import {
  createServerIssue,
  fetchServerIssues,
  updateServerIssue,
  type ServerUpdateIssueData,
} from '../../../lib/issuesApi'
import type { Issue, Priority, Status } from '../../../data/mock'
import type {
  ToolDefinition,
  IssueToolResponse,
  ToolResult,
  ToolRuntimeContext,
  ToolType,
  WebSearchResponse,
  ApiCallResponse,
} from './types'

// --- Mock data for web search ---

const MOCK_SEARCH_RESULTS: Record<string, WebSearchResponse> = {
  default: {
    query: '',
    results: [
      {
        title: 'React 19 — What\'s New and Migration Guide',
        url: 'https://react.dev/blog/2024/react-19',
        snippet: 'React 19 introduces Actions, a new way to handle form submissions and data mutations. The use() hook enables reading resources like promises and context...',
        favicon: 'https://react.dev/favicon.ico',
      },
      {
        title: 'Understanding Server Components in React 19',
        url: 'https://vercel.com/blog/understanding-react-server-components',
        snippet: 'Server Components allow you to render components on the server, reducing the JavaScript bundle sent to the client. Learn how to integrate them into your existing apps...',
      },
      {
        title: 'TypeScript 5.9 Release Notes — Microsoft Developer Blogs',
        url: 'https://devblogs.microsoft.com/typescript/typescript-5-9/',
        snippet: 'TypeScript 5.9 brings import defer, improved type narrowing for indexed access types, and better performance for large-scale projects...',
      },
      {
        title: 'Vite 8.0 — Next Generation Frontend Tooling',
        url: 'https://vite.dev/blog/announcing-vite8',
        snippet: 'Vite 8 ships with Environment API stabilization, Rolldown integration for faster builds, and first-class support for module federation...',
      },
    ],
  },
  tailwind: {
    query: 'tailwind css',
    results: [
      {
        title: 'Tailwind CSS v4.0 — A New Engine, Built for Speed',
        url: 'https://tailwindcss.com/blog/tailwindcss-v4',
        snippet: 'Tailwind CSS v4.0 is a ground-up rewrite with a new high-performance engine written in Rust, delivering full builds in under 100ms...',
      },
      {
        title: 'Migrating from Tailwind CSS v3 to v4 — Official Guide',
        url: 'https://tailwindcss.com/docs/upgrade-guide',
        snippet: 'Step-by-step migration guide covering the new CSS-first configuration approach, updated color palette, and removal of deprecated utilities...',
      },
      {
        title: 'Tailwind CSS Best Practices for Large-Scale Applications',
        url: 'https://css-tricks.com/tailwind-best-practices-2025/',
        snippet: 'Learn how to organize Tailwind in large codebases: component extraction patterns, design token management, and avoiding utility class explosion...',
      },
    ],
  },
  api: {
    query: 'api design',
    results: [
      {
        title: 'REST API Design Best Practices — 2025 Edition',
        url: 'https://blog.postman.com/rest-api-design-best-practices/',
        snippet: 'Comprehensive guide to designing REST APIs: resource naming, pagination, error handling, versioning, and HATEOAS principles...',
      },
      {
        title: 'GraphQL vs REST vs gRPC — When to Use What',
        url: 'https://www.apollographql.com/blog/graphql-vs-rest-vs-grpc',
        snippet: 'A detailed comparison of API paradigms for modern applications. Learn when GraphQL shines over REST and where gRPC fits best...',
      },
      {
        title: 'Building Type-Safe APIs with tRPC and Zod',
        url: 'https://trpc.io/docs/getting-started',
        snippet: 'tRPC enables end-to-end type-safe APIs without code generation. Combined with Zod for runtime validation, you get full-stack type safety...',
      },
    ],
  },
}

const MOCK_API_RESPONSES: ApiCallResponse[] = [
  {
    endpoint: '/api/v1/status',
    method: 'GET',
    statusCode: 200,
    body: {
      status: 'healthy',
      version: '2.4.1',
      uptime: '14d 6h 32m',
      services: {
        database: 'connected',
        cache: 'connected',
        queue: 'connected',
      },
    },
  },
  {
    endpoint: '/api/v1/analytics/summary',
    method: 'GET',
    statusCode: 200,
    body: {
      totalUsers: 12847,
      activeToday: 3241,
      requestsPerMinute: 892,
      errorRate: '0.12%',
      p99Latency: '142ms',
    },
  },
]

// --- Tool implementations ---

async function executeWebSearch(
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<ToolResult> {
  const query = String(args.query || '')
  const start = Date.now()

  // Simulate network delay
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 800 + Math.random() * 1200)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

  // Pick mock results based on query keywords
  const lq = query.toLowerCase()
  let response: WebSearchResponse
  if (lq.includes('tailwind') || lq.includes('css')) {
    response = { ...MOCK_SEARCH_RESULTS.tailwind, query }
  } else if (lq.includes('api') || lq.includes('rest') || lq.includes('graphql')) {
    response = { ...MOCK_SEARCH_RESULTS.api, query }
  } else {
    response = { ...MOCK_SEARCH_RESULTS.default, query }
  }

  return { data: response, duration: Date.now() - start }
}

async function executeApiCall(
  _args: Record<string, unknown>,
  signal: AbortSignal
): Promise<ToolResult> {
  const start = Date.now()

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500 + Math.random() * 800)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

  const response = MOCK_API_RESPONSES[Math.floor(Math.random() * MOCK_API_RESPONSES.length)]
  return { data: response, duration: Date.now() - start }
}

async function executeCodeExec(
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<ToolResult> {
  const start = Date.now()

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 300 + Math.random() * 600)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

  const code = String(args.code || 'console.log("Hello")')
  return {
    data: {
      code,
      output: `> ${code}\n← "Result computed successfully"`,
      exitCode: 0,
    },
    duration: Date.now() - start,
  }
}

const statuses: Status[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]
const priorities: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

function requireIssueRuntime(context?: ToolRuntimeContext) {
  if (!context?.issueTools) {
    throw new Error('Issue tools are not available in this chat context')
  }
  return context.issueTools
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStatus(value: unknown): Status | undefined {
  const normalized = asText(value)?.toLowerCase().replace(/[\s-]+/g, '_')
  return statuses.includes(normalized as Status) ? (normalized as Status) : undefined
}

function asPriority(value: unknown): Priority | undefined {
  const normalized = asText(value)?.toLowerCase()
  return priorities.includes(normalized as Priority) ? (normalized as Priority) : undefined
}

function asLabels(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
  }
  const text = asText(value)
  return text ? text.split(',').map((label) => label.trim()).filter(Boolean) : undefined
}

function matchesIssueRef(issue: Issue, ref: string) {
  const normalized = ref.trim().toLowerCase()
  return (
    issue.id.toLowerCase() === normalized ||
    issue.identifier.toLowerCase() === normalized
  )
}

async function fetchCanonicalIssues(context?: ToolRuntimeContext) {
  const runtime = requireIssueRuntime(context)
  const issues = await fetchServerIssues()
  runtime.syncIssues(issues)
  return issues
}

async function resolveIssue(ref: unknown, context?: ToolRuntimeContext) {
  const issueRef = asText(ref)
  if (!issueRef) throw new Error('Issue id or identifier is required')

  const issues = await fetchCanonicalIssues(context)
  const issue = issues.find((candidate) => matchesIssueRef(candidate, issueRef))
  if (!issue) throw new Error(`Issue not found: ${issueRef}`)
  return issue
}

function filterIssues(issues: Issue[], args: Record<string, unknown>) {
  const query = asText(args.query)?.toLowerCase()
  const status = asStatus(args.status)
  const priority = asPriority(args.priority)
  const assignee = asText(args.assignee)?.toLowerCase()

  return issues.filter((issue) => {
    if (status && issue.status !== status) return false
    if (priority && issue.priority !== priority) return false
    if (assignee && issue.assignee?.toLowerCase() !== assignee) return false
    if (!query) return true

    const haystack = [
      issue.id,
      issue.identifier,
      issue.title,
      issue.description,
      issue.status,
      issue.priority,
      issue.assignee ?? '',
      issue.project,
      ...issue.labels,
    ].join(' ').toLowerCase()
    return haystack.includes(query)
  })
}

function limitIssues(issues: Issue[], args: Record<string, unknown>) {
  const rawLimit = Number(args.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 25) : 10
  return issues.slice(0, limit)
}

function issueListMessage(action: IssueToolResponse['action'], issues: Issue[], total: number) {
  const noun = total === 1 ? 'issue' : 'issues'
  if (action === 'get') return `Found ${issues[0]?.identifier ?? 'issue'}`
  if (action === 'create') return `Created ${issues[0]?.identifier ?? 'issue'}`
  if (action === 'update') return `Updated ${issues[0]?.identifier ?? 'issue'}`
  if (action === 'move') return `Moved ${issues[0]?.identifier ?? 'issue'}`
  return `${total} ${noun} matched`
}

async function executeIssueSearch(
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  const start = Date.now()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const issues = filterIssues(await fetchCanonicalIssues(context), args)
  return {
    data: {
      action: 'search',
      issues: limitIssues(issues, args),
      total: issues.length,
      message: issueListMessage('search', issues, issues.length),
    } satisfies IssueToolResponse,
    duration: Date.now() - start,
  }
}

async function executeIssueList(
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  const start = Date.now()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const issues = filterIssues(await fetchCanonicalIssues(context), args)
  return {
    data: {
      action: 'list',
      issues: limitIssues(issues, args),
      total: issues.length,
      message: issueListMessage('list', issues, issues.length),
    } satisfies IssueToolResponse,
    duration: Date.now() - start,
  }
}

async function executeIssueGet(
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  const start = Date.now()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const issue = await resolveIssue(args.issueId ?? args.identifier ?? args.id, context)
  return {
    data: {
      action: 'get',
      issues: [issue],
      total: 1,
      message: issueListMessage('get', [issue], 1),
    } satisfies IssueToolResponse,
    duration: Date.now() - start,
  }
}

async function executeIssueCreate(
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  const runtime = requireIssueRuntime(context)
  const start = Date.now()
  const title = asText(args.title)
  if (!title) throw new Error('Issue title is required')
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const issue = await createServerIssue({
    title,
    description: asText(args.description) ?? '',
    status: asStatus(args.status) ?? 'todo',
    priority: asPriority(args.priority) ?? 'none',
    assignee: asText(args.assignee) ?? null,
    labels: asLabels(args.labels) ?? [],
    project: asText(args.project),
  })
  runtime.syncIssue(issue)

  return {
    data: {
      action: 'create',
      issues: [issue],
      total: 1,
      message: issueListMessage('create', [issue], 1),
    } satisfies IssueToolResponse,
    duration: Date.now() - start,
  }
}

function buildIssueUpdate(args: Record<string, unknown>): ServerUpdateIssueData {
  const update: ServerUpdateIssueData = {}
  const title = asText(args.title)
  const description = asText(args.description)
  const status = asStatus(args.status)
  const priority = asPriority(args.priority)
  const assignee = asText(args.assignee)
  const labels = asLabels(args.labels)
  const project = asText(args.project)

  if (title) update.title = title
  if (description !== undefined) update.description = description
  if (status) update.status = status
  if (priority) update.priority = priority
  if (assignee !== undefined || args.assignee === null) update.assignee = assignee ?? null
  if (labels) update.labels = labels
  if (project) update.project = project

  return update
}

async function executeIssueUpdate(
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  const runtime = requireIssueRuntime(context)
  const start = Date.now()
  const existing = await resolveIssue(args.issueId ?? args.identifier ?? args.id, context)
  const update = buildIssueUpdate(args)
  if (Object.keys(update).length === 0) {
    throw new Error('No issue fields were provided to update')
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const issue = await updateServerIssue(existing.id, update)
  runtime.syncIssue(issue)

  return {
    data: {
      action: 'update',
      issues: [issue],
      total: 1,
      message: issueListMessage('update', [issue], 1),
    } satisfies IssueToolResponse,
    duration: Date.now() - start,
  }
}

async function executeIssueMove(
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  return executeIssueUpdate(
    { ...args, status: asStatus(args.status) ?? asStatus(args.to) },
    signal,
    context
  ).then((result) => {
    const response = result.data as IssueToolResponse
    return {
      ...result,
      data: {
        ...response,
        action: 'move',
        message: issueListMessage('move', response.issues, response.total),
      } satisfies IssueToolResponse,
    }
  })
}

// --- Tool registry ---

const toolRegistry = new Map<ToolType, ToolDefinition>()

export function registerTool(definition: ToolDefinition) {
  toolRegistry.set(definition.type, definition)
}

export function getTool(type: ToolType): ToolDefinition | undefined {
  return toolRegistry.get(type)
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(toolRegistry.values())
}

// Register built-in tools
registerTool({
  type: 'web_search',
  name: 'Web Search',
  description: 'Search the web for current information',
  icon: 'search',
  execute: executeWebSearch,
})

registerTool({
  type: 'issue_search',
  name: 'Issue Search',
  description: 'Search Photon issues from the canonical server issue store',
  icon: 'issues',
  execute: executeIssueSearch,
})

registerTool({
  type: 'issue_list',
  name: 'Issue List',
  description: 'List Photon issues from the canonical server issue store',
  icon: 'issues',
  execute: executeIssueList,
})

registerTool({
  type: 'issue_get',
  name: 'Issue Lookup',
  description: 'Get a Photon issue by id or identifier',
  icon: 'issue',
  execute: executeIssueGet,
})

registerTool({
  type: 'issue_create',
  name: 'Create Issue',
  description: 'Create a Photon issue through the canonical server issue API',
  icon: 'issue-plus',
  execute: executeIssueCreate,
})

registerTool({
  type: 'issue_update',
  name: 'Update Issue',
  description: 'Update Photon issue fields through the canonical server issue API',
  icon: 'issue-edit',
  execute: executeIssueUpdate,
})

registerTool({
  type: 'issue_move',
  name: 'Move Issue',
  description: 'Move a Photon issue to another workflow status',
  icon: 'issue-move',
  execute: executeIssueMove,
})

registerTool({
  type: 'api_call',
  name: 'API Call',
  description: 'Execute an external API request',
  icon: 'api',
  execute: executeApiCall,
})

registerTool({
  type: 'code_exec',
  name: 'Code Execution',
  description: 'Execute a code snippet',
  icon: 'code',
  execute: executeCodeExec,
})

// --- Executor ---

let nextToolCallId = 1

export function generateToolCallId(): string {
  return `tool-${nextToolCallId++}`
}

export async function executeTool(
  type: ToolType,
  args: Record<string, unknown>,
  signal: AbortSignal,
  context?: ToolRuntimeContext
): Promise<ToolResult> {
  const tool = toolRegistry.get(type)
  if (!tool) {
    return { data: null, error: `Unknown tool type: ${type}` }
  }

  try {
    return await tool.execute(args, signal, context)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { data: null, error: 'Tool execution was cancelled', cancelled: true }
    }
    return { data: null, error: String(err) }
  }
}
