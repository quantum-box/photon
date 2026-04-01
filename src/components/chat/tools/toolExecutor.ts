/**
 * Tool execution framework.
 * Registry-based system for registering and executing external tools.
 */

import type { ToolDefinition, ToolResult, ToolType, WebSearchResponse, ApiCallResponse } from './types'

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
  signal: AbortSignal
): Promise<ToolResult> {
  const tool = toolRegistry.get(type)
  if (!tool) {
    return { data: null, error: `Unknown tool type: ${type}` }
  }

  try {
    return await tool.execute(args, signal)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { data: null, error: 'Tool execution was cancelled' }
    }
    return { data: null, error: String(err) }
  }
}
