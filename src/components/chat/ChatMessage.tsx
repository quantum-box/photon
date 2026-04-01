import { memo } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useStreamingText } from './useStreamingText'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

function StreamingMessage({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const displayed = useStreamingText(content, isStreaming)

  return (
    <div className="relative">
      <MarkdownRenderer content={displayed} />
      {isStreaming && displayed.length < content.length && (
        <span
          className="inline-block w-0.5 h-4 ml-0.5 align-text-bottom animate-blink"
          style={{ background: 'var(--accent)' }}
        />
      )}
    </div>
  )
}

interface ChatMessageProps {
  message: Message
  isStreaming?: boolean
}

export const ChatMessage = memo(function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex gap-3 px-4 py-3 ${isUser ? '' : 'bg-[var(--bg-surface)]/30'}`}>
      {/* Avatar */}
      <div
        className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold mt-0.5"
        style={{
          background: isUser ? 'var(--bg-hover)' : 'var(--accent)',
          color: isUser ? 'var(--text-secondary)' : '#fff',
        }}
      >
        {isUser ? 'U' : 'A'}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {isUser ? 'You' : 'Assistant'}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {isUser ? (
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {message.content}
          </div>
        ) : (
          <StreamingMessage content={message.content} isStreaming={isStreaming} />
        )}
      </div>
    </div>
  )
})
