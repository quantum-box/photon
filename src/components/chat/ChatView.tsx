import { useState, useCallback, useRef, type KeyboardEvent } from 'react'
import { ChatMessage, type Message } from './ChatMessage'
import { useAutoScroll } from './useAutoScroll'
import { startMockSSE } from './mockSSE'

let nextId = 1
function genId() {
  return `msg-${nextId++}`
}

export function ChatView() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll follows the latest message content
  const latestContent = messages[messages.length - 1]?.content ?? ''
  const { containerRef, handleScroll, scrollToBottom } = useAutoScroll([
    messages.length,
    latestContent.length,
  ])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isStreaming) return

    // Add user message
    const userMsg: Message = {
      id: genId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }

    // Prepare assistant message placeholder
    const assistantId = genId()
    setStreamingId(assistantId)
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setIsStreaming(true)

    // Auto-resize textarea back
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Start SSE stream
    const controller = startMockSSE(text, {
      onChunk(chunk) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        )
      },
      onDone() {
        setIsStreaming(false)
        setStreamingId(null)
      },
    })

    abortRef.current = controller
  }, [input, isStreaming])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    setIsStreaming(false)
    setStreamingId(null)
  }, [])

  const handleDelete = useCallback((messageId: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId)
      if (idx === -1) return prev
      const msg = prev[idx]
      // Delete assistant message and its preceding user message as a pair
      if (msg.role === 'assistant' && idx > 0 && prev[idx - 1].role === 'user') {
        return [...prev.slice(0, idx - 1), ...prev.slice(idx + 1)]
      }
      // Delete user message and its following assistant message as a pair
      if (msg.role === 'user' && idx < prev.length - 1 && prev[idx + 1].role === 'assistant') {
        return [...prev.slice(0, idx), ...prev.slice(idx + 2)]
      }
      return prev.filter((m) => m.id !== messageId)
    })
  }, [])

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return
    // Find the last user message to re-send
    const lastUserIdx = messages.findLastIndex((m) => m.role === 'user')
    if (lastUserIdx === -1) return

    const userText = messages[lastUserIdx].content

    // Remove the last assistant message
    const newMessages = messages.slice(0, messages.length - 1)

    // Create new assistant placeholder
    const assistantId = genId()
    setStreamingId(assistantId)
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }

    setMessages([...newMessages, assistantMsg])
    setIsStreaming(true)

    const controller = startMockSSE(userText, {
      onChunk(chunk) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        )
      },
      onDone() {
        setIsStreaming(false)
        setStreamingId(null)
      },
    })

    abortRef.current = controller
  }, [isStreaming, messages])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div
                className="text-4xl mb-3 w-14 h-14 rounded-2xl flex items-center justify-center mx-auto"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                P
              </div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                Photon Chat
              </h2>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Send a message to start a conversation
              </p>
            </div>
          </div>
        ) : (
          <div className="py-2">
            {messages.map((msg, idx) => {
              const isLastAssistant =
                msg.role === 'assistant' &&
                idx === messages.length - 1
              return (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isStreaming={isStreaming && msg.id === streamingId}
                  isLastAssistant={isLastAssistant}
                  onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                  onDelete={() => handleDelete(msg.id)}
                />
              )
            })}

            {/* Streaming indicator */}
            {isStreaming && (
              <div className="px-4 py-2">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce-dot" style={{ background: 'var(--accent)', animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce-dot" style={{ background: 'var(--accent)', animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce-dot" style={{ background: 'var(--accent)', animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            {/* Scroll anchor */}
            <div className="h-4" />
          </div>
        )}
      </div>

      {/* Scroll-to-bottom button */}
      <div className="relative">
        <button
          onClick={() => scrollToBottom()}
          className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs transition-opacity hover:opacity-90 cursor-pointer"
          style={{
            background: 'var(--bg-surface)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-color)',
            opacity: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
        >
          Scroll to bottom
        </button>
      </div>

      {/* Input area */}
      <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
        <div
          className="flex items-end gap-2 rounded-xl px-4 py-3"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-sm leading-relaxed"
            style={{
              color: 'var(--text-primary)',
              maxHeight: '200px',
            }}
          />
          {isStreaming ? (
            <button
              onClick={handleStop}
              className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer"
              style={{ background: 'var(--priority-urgent)', color: '#fff' }}
              title="Stop generating"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30"
              style={{
                background: input.trim() ? 'var(--accent)' : 'var(--bg-hover)',
                color: '#fff',
              }}
              title="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2L2 8.5L6.5 10L10 6L7 10.5L8.5 14.5L14 2Z" />
              </svg>
            </button>
          )}
        </div>
        <p className="text-center mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          Photon AI can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  )
}
