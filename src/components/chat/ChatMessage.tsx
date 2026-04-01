import { memo, useState } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useStreamingText } from './useStreamingText'
import { ToolResultCard } from './tools/ToolResultCard'
import { FileChip } from '../files/FileChip'
import type { ToolCall } from './tools/types'
import type { FileAttachment } from '../files/types'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  toolCalls?: ToolCall[]
  attachments?: FileAttachment[]
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

function ActionButton({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-hover)]"
      style={{ color: 'var(--text-muted)' }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
    >
      {icon}
    </button>
  )
}

const CopyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

const CheckIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const RegenerateIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
)

const DeleteIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

interface ChatMessageProps {
  message: Message
  isStreaming?: boolean
  isLastAssistant?: boolean
  onRegenerate?: () => void
  onDelete?: () => void
  onPreviewFile?: (file: FileAttachment) => void
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming = false,
  isLastAssistant = false,
  onRegenerate,
  onDelete,
  onPreviewFile,
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const showActions = !isStreaming && message.content.length > 0

  return (
    <div className={`group relative flex gap-3 px-4 py-3 ${isUser ? '' : 'bg-[var(--bg-surface)]/30'}`}>
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

        {/* File attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.attachments.map((att) => (
              <FileChip
                key={att.id}
                file={att}
                onPreview={onPreviewFile ?? (() => {})}
              />
            ))}
          </div>
        )}

        {/* Tool calls (rendered before text content) */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2">
            {message.toolCalls.map((tc) => (
              <ToolResultCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {isUser ? (
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {message.content}
          </div>
        ) : (
          <StreamingMessage content={message.content} isStreaming={isStreaming} />
        )}

        {/* Action bar */}
        {showActions && (
          <div
            className="flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ActionButton
              icon={copied ? CheckIcon : CopyIcon}
              title={copied ? 'Copied!' : 'Copy message'}
              onClick={handleCopy}
            />
            {!isUser && isLastAssistant && onRegenerate && (
              <ActionButton icon={RegenerateIcon} title="Regenerate" onClick={onRegenerate} />
            )}
            {onDelete && (
              <ActionButton icon={DeleteIcon} title="Delete message" onClick={onDelete} />
            )}
          </div>
        )}
      </div>
    </div>
  )
})
