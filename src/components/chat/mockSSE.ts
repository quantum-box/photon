/**
 * Mock SSE stream that simulates an AI assistant responding.
 * Chunks are delivered at varying intervals to simulate real streaming.
 */

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

export interface SSECallbacks {
  onChunk: (text: string) => void
  onDone: () => void
}

export function startMockSSE(
  _userMessage: string,
  { onChunk, onDone }: SSECallbacks
): AbortController {
  const controller = new AbortController()
  const response = SAMPLE_RESPONSES[Math.floor(Math.random() * SAMPLE_RESPONSES.length)]

  // Simulate chunked delivery like real SSE
  let offset = 0
  const signal = controller.signal

  function sendNextChunk() {
    if (signal.aborted || offset >= response.length) {
      if (!signal.aborted) onDone()
      return
    }

    // Variable chunk size (1-15 chars) for natural feel
    const chunkSize = Math.floor(Math.random() * 14) + 1
    const chunk = response.slice(offset, offset + chunkSize)
    offset += chunkSize
    onChunk(chunk)

    // Variable delay: shorter for small chunks, occasional pause at punctuation
    const isPunctuation = /[.!?\n]$/.test(chunk)
    const delay = isPunctuation
      ? Math.random() * 80 + 40
      : Math.random() * 30 + 10

    setTimeout(sendNextChunk, delay)
  }

  // Initial delay to simulate network latency
  setTimeout(sendNextChunk, 300)

  return controller
}
