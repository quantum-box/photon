/**
 * Mock SSE stream that simulates an AI assistant responding.
 * Detects tool-triggering keywords and executes tools before streaming text.
 */

import type { ToolCall, ToolRuntimeContext, ToolType } from './tools/types'
import { executeTool, generateToolCallId } from './tools/toolExecutor'

const SAMPLE_RESPONSES = [
  `## Project Analysis

Here's a breakdown of the current architecture:

1. **Frontend Layer** - React with TypeScript
2. **State Management** - Hooks-based with \`useState\` and \`useCallback\`
3. **Styling** - Tailwind CSS with CSS custom properties

### Key Observations

The codebase follows a component-based architecture with clear separation of concerns. Each view component handles its own state while the parent \`App\` manages shared state.

\`\`\`typescript
// Example: Optimistic update pattern
const handleMoveIssue = useCallback((issueId: string, newStatus: Status) => {
  setIssues(prev =>
    prev.map(i => (i.id === issueId ? { ...i, status: newStatus } : i))
  )
}, [])
\`\`\`

### Recommendations

- Consider adding **virtual scrolling** for large datasets
- Implement \`useMemo\` for expensive filter operations
- Add error boundaries around view components

> The current implementation is solid for the scale, but will benefit from these optimizations as data grows.

| Component | Complexity | Status |
|-----------|-----------|--------|
| TableView | Medium | Done |
| KanbanView | High | Done |
| DetailPanel | Low | Done |`,

  `I can help with that! Let me walk you through the solution.

### Step 1: Setup

First, install the required dependencies:

\`\`\`bash
npm install @tanstack/react-query zod
\`\`\`

### Step 2: Define the Schema

\`\`\`typescript
import { z } from 'zod'

const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['admin', 'user', 'viewer']),
})

type User = z.infer<typeof UserSchema>
\`\`\`

### Step 3: Create the Hook

\`\`\`typescript
function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/users')
      const data = await res.json()
      return UserSchema.array().parse(data)
    },
  })
}
\`\`\`

This gives you **type-safe data fetching** with runtime validation. Any malformed response will throw immediately rather than causing silent bugs downstream.`,

  `That's a great question. Here's a concise comparison:

- **SSE (Server-Sent Events)**: One-way server-to-client, auto-reconnect, simple HTTP
- **WebSockets**: Full duplex, lower latency, more complex setup
- **Long Polling**: Simple fallback, higher overhead, works everywhere

For streaming AI responses, SSE is usually the best choice because:

1. We only need server-to-client communication
2. Built-in reconnection handling
3. Works through proxies and load balancers
4. Simple to implement with \`EventSource\` API`,
]

const SEARCH_FOLLOW_UP_RESPONSES = [
  `Based on the search results, here's what I found:

### Key Findings

The latest documentation and community resources confirm the following:

1. **Performance** — The newest versions ship significant performance improvements through engine rewrites and optimized build pipelines
2. **Migration** — Official migration guides are available for major version upgrades
3. **Best Practices** — The community has established clear patterns for large-scale applications

I'd recommend checking the official documentation links above for the most up-to-date details. Let me know if you'd like me to dive deeper into any specific area.`,

  `Here's a summary of what the search results reveal:

### Overview

The search results provide several relevant resources. The key takeaway is that the ecosystem is actively evolving with strong community support and comprehensive documentation.

### Recommendations

- Start with the **official guides** linked above for the most accurate information
- Review the **best practices** articles for production-ready patterns
- Consider the **comparison articles** to make informed architectural decisions

Would you like me to search for anything more specific?`,
]

const API_FOLLOW_UP_RESPONSES = [
  `The API returned successfully. Here's my analysis:

### Status Overview

All services are reporting **healthy** status with good connectivity. The key metrics look solid:

- Response times are within acceptable thresholds
- Error rates are minimal
- All dependent services are connected and responsive

This suggests the system is operating normally. Let me know if you'd like to investigate any specific endpoint or metric further.`,

  `The API response looks good. Let me break down what we're seeing:

### Analysis

The data shows a healthy system with normal operating parameters. All critical metrics are within expected ranges.

If you need to drill deeper into any particular service or need historical trending data, I can make additional API calls to gather that information.`,
]

const DOCUMENT_CONTEXT_RESPONSE =
  'I have the current document context available, including the active document, selected text, and related issues. I can use that context when creating or searching issues.'

export interface SSECallbacks {
  onChunk: (text: string) => void
  onDone: () => void
  onToolCallStart?: (toolCall: ToolCall) => void
  onToolCallUpdate?: (toolCall: ToolCall) => void
}

// Detect if a user message should trigger tool calls
interface DetectedTool {
  type: ToolType
  args: Record<string, unknown>
}

const statusAliases: Record<string, string> = {
  backlog: 'backlog',
  todo: 'todo',
  'to do': 'todo',
  'in progress': 'in_progress',
  in_progress: 'in_progress',
  progress: 'in_progress',
  'in review': 'in_review',
  in_review: 'in_review',
  review: 'in_review',
  done: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

function extractQuotedText(message: string) {
  return message.match(/["'「](.+?)["'」]/)?.[1]?.trim()
}

function extractIssueRef(message: string) {
  return (
    message.match(/<issue\s+id=["']([^"']+)["'][^>]*>/i)?.[1] ??
    message.match(/\bPLT-\d+\b/i)?.[0] ??
    message.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0]
  )
}

function extractStatus(message: string) {
  const lower = message.toLowerCase().replace(/[_-]+/g, ' ')
  const aliases = Object.entries(statusAliases).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, status] of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(lower)) return status
  }
  return undefined
}

function extractCreateTitle(message: string) {
  const quoted = extractQuotedText(message)
  if (quoted) return quoted

  return message
    .replace(/(?:please|この内容で|issue|チケット|課題|を|で|作って|作成|create|new|add)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function detectToolTriggers(message: string): DetectedTool[] {
  const lower = message.toLowerCase()
  const tools: DetectedTool[] = []
  const hasIssueIntent = /(?:issue|issues|チケット|課題|plt-\d+|<issue)/i.test(message)

  if (hasIssueIntent) {
    const issueRef = extractIssueRef(message)
    const status = extractStatus(message)
    const isCreate = /(?:create|new|add|作成|作って)/i.test(message)
    const isMove = Boolean(issueRef && status && /(?:move|set|update|change|to|にして|へ|変更)/i.test(message))
    const isGet = Boolean(issueRef && /(?:get|show|open|lookup|detail|詳細|見せて)/i.test(message))
    const isList = /(?:list|show|一覧|まとめ)/i.test(message)
    const isSearch = /(?:search|find|filter|検索|探し|blocker|ブロッカー)/i.test(message)

    if (isCreate) {
      tools.push({
        type: 'issue_create',
        args: {
          title: extractCreateTitle(message),
          status,
        },
      })
      return tools
    }

    if (isMove) {
      tools.push({
        type: 'issue_move',
        args: {
          issueId: issueRef,
          status,
        },
      })
      return tools
    }

    if (isGet) {
      tools.push({ type: 'issue_get', args: { issueId: issueRef } })
      return tools
    }

    if (isList || isSearch) {
      const query = extractQuotedText(message) ?? message
        .replace(/(?:issue|issues|チケット|課題|search|find|filter|検索|探し|一覧|まとめ|show|list)/gi, ' ')
        .trim()
      tools.push({
        type: isList && !isSearch ? 'issue_list' : 'issue_search',
        args: { query, status, limit: 8 },
      })
      return tools
    }
  }

  // Web search triggers
  const searchPatterns = [
    /(?:search|検索|調べ|look\s*up|find\s+(?:info|information|details)|google|ググ|探し)/i,
    /(?:what\s+is|what\s+are|how\s+to|latest|newest|最新)/i,
  ]
  if (searchPatterns.some((p) => p.test(lower))) {
    // Extract a search query from the message
    const query = message
      .replace(/(?:search|検索|調べ|look\s*up|google|ググ|please|して|について|を|の|で|に|は|が)/gi, '')
      .trim()
      .slice(0, 100) || message.slice(0, 60)
    tools.push({ type: 'web_search', args: { query } })
  }

  // API call triggers
  const apiPatterns = [
    /(?:api|endpoint|fetch|status|health\s*check|call|request|リクエスト)/i,
  ]
  if (apiPatterns.some((p) => p.test(lower)) && !tools.some((t) => t.type === 'web_search')) {
    tools.push({
      type: 'api_call',
      args: { endpoint: '/api/v1/status', method: 'GET' },
    })
  }

  // Code execution triggers
  const codePatterns = [
    /(?:run|execute|eval|実行|コード)/i,
  ]
  if (codePatterns.some((p) => p.test(lower)) && lower.includes('code') || lower.includes('コード')) {
    tools.push({
      type: 'code_exec',
      args: { code: 'console.log("Analysis complete")' },
    })
  }

  return tools
}

export function startMockSSE(
  userMessage: string,
  { onChunk, onDone, onToolCallStart, onToolCallUpdate }: SSECallbacks,
  context?: ToolRuntimeContext
): AbortController {
  const controller = new AbortController()
  const signal = controller.signal

  const detectedTools = detectToolTriggers(userMessage)
  const wantsDocumentContext = context?.documentContext &&
    /(?:context|document|doc|selected|selection|選択|ドキュメント)/i.test(userMessage)

  if (detectedTools.length > 0 && onToolCallStart && onToolCallUpdate) {
    // Execute tools first, then stream response
    executeToolsAndStream(detectedTools, signal, onChunk, onDone, onToolCallStart, onToolCallUpdate, context)
  } else {
    // Normal text-only response
    const response = wantsDocumentContext
      ? DOCUMENT_CONTEXT_RESPONSE
      : SAMPLE_RESPONSES[Math.floor(Math.random() * SAMPLE_RESPONSES.length)]
    streamText(response, signal, onChunk, onDone)
  }

  return controller
}

async function executeToolsAndStream(
  tools: DetectedTool[],
  signal: AbortSignal,
  onChunk: (text: string) => void,
  onDone: () => void,
  onToolCallStart: (toolCall: ToolCall) => void,
  onToolCallUpdate: (toolCall: ToolCall) => void,
  context?: ToolRuntimeContext,
) {
  let hasSearch = false
  let hasApi = false
  let hasIssue = false

  for (const tool of tools) {
    if (signal.aborted) { onDone(); return }

    const toolCall: ToolCall = {
      id: generateToolCallId(),
      type: tool.type,
      name: tool.type === 'web_search' ? 'Web Search'
        : tool.type === 'api_call' ? 'API Call'
        : tool.type === 'code_exec' ? 'Code Execution'
        : tool.type === 'issue_search' ? 'Issue Search'
        : tool.type === 'issue_list' ? 'Issue List'
        : tool.type === 'issue_get' ? 'Issue Lookup'
        : tool.type === 'issue_create' ? 'Create Issue'
        : tool.type === 'issue_update' ? 'Update Issue'
        : 'Move Issue',
      args: tool.args,
      status: 'running',
    }

    // Notify: tool started
    onToolCallStart(toolCall)

    if (tool.type === 'web_search') hasSearch = true
    if (tool.type === 'api_call') hasApi = true
    if (tool.type.startsWith('issue_')) hasIssue = true

    let updatedToolCall: ToolCall
    try {
      const result = await executeTool(tool.type, tool.args, signal, context)
      updatedToolCall = {
        ...toolCall,
        status: result.cancelled ? 'cancelled' : result.error ? 'error' : 'completed',
        result,
      }
    } catch {
      updatedToolCall = {
        ...toolCall,
        status: 'error',
        result: { data: null, error: 'Tool execution failed' },
      }
    }

    // Notify: tool completed
    onToolCallUpdate(updatedToolCall)
  }

  if (signal.aborted) { onDone(); return }

  // Small pause before streaming text response
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 400)
    signal.addEventListener('abort', () => clearTimeout(t))
  })

  // Pick a follow-up response based on what tools ran
  let response: string
  if (hasIssue) {
    response = `Done. I updated the workspace issue data through the server-backed issue store.`
  } else if (hasSearch) {
    response = SEARCH_FOLLOW_UP_RESPONSES[Math.floor(Math.random() * SEARCH_FOLLOW_UP_RESPONSES.length)]
  } else if (hasApi) {
    response = API_FOLLOW_UP_RESPONSES[Math.floor(Math.random() * API_FOLLOW_UP_RESPONSES.length)]
  } else {
    response = SAMPLE_RESPONSES[Math.floor(Math.random() * SAMPLE_RESPONSES.length)]
  }

  streamText(response, signal, onChunk, onDone)
}

function streamText(
  response: string,
  signal: AbortSignal,
  onChunk: (text: string) => void,
  onDone: () => void,
) {
  let offset = 0

  function sendNextChunk() {
    if (signal.aborted || offset >= response.length) {
      if (!signal.aborted) onDone()
      return
    }

    const chunkSize = Math.floor(Math.random() * 14) + 1
    const chunk = response.slice(offset, offset + chunkSize)
    offset += chunkSize
    onChunk(chunk)

    const isPunctuation = /[.!?\n]$/.test(chunk)
    const delay = isPunctuation
      ? Math.random() * 80 + 40
      : Math.random() * 30 + 10

    setTimeout(sendNextChunk, delay)
  }

  setTimeout(sendNextChunk, 300)
}
