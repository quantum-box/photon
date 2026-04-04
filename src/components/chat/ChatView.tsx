import { useState, useCallback, useRef, type KeyboardEvent } from 'react'
import { ChatMessage, type Message } from './ChatMessage'
import { useAutoScroll } from './useAutoScroll'
import { startMockSSE } from './mockSSE'
import { FileChip } from '../files/FileChip'
import { FilePreviewModal } from '../files/FilePreviewModal'
import { type FileAttachment, detectFileType } from '../files/types'
import type { ToolCall } from './tools/types'

const ACCEPTED_TYPES = '.pdf,.xlsx,.xls,.csv,.docx,.pptx'

let nextId = 1
function genId() {
  return `msg-${nextId++}`
}

let fileNextId = 1
function genFileId() {
  return `file-${fileNextId++}`
}

function createFileAttachment(file: File): FileAttachment {
  return {
    id: genFileId(),
    name: file.name,
    size: file.size,
    type: file.type,
    url: URL.createObjectURL(file),
    file,
  }
}

export function ChatView() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([])
  const [previewFile, setPreviewFile] = useState<FileAttachment | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll follows the latest message content
  const latestContent = messages[messages.length - 1]?.content ?? ''
  const latestToolCalls = messages[messages.length - 1]?.toolCalls?.length ?? 0
  const { containerRef, handleScroll, scrollToBottom } = useAutoScroll([
    messages.length,
    latestContent.length,
    latestToolCalls,
  ])

  const handleFilesSelected = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const supported = fileArray.filter((f) => {
      const type = detectFileType(f)
      return type !== 'unknown'
    })
    if (supported.length > 0) {
      setPendingFiles((prev) => [...prev, ...supported.map(createFileAttachment)])
    }
  }, [])

  const handleRemovePendingFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === fileId)
      if (file) URL.revokeObjectURL(file.url)
      return prev.filter((f) => f.id !== fileId)
    })
  }, [])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if ((!text && pendingFiles.length === 0) || isStreaming) return

    // Add user message with attachments
    const userMsg: Message = {
      id: genId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
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
    setPendingFiles([])
    setIsStreaming(true)

    // Auto-resize textarea back
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Build prompt with file context
    const fileContext = userMsg.attachments
      ? userMsg.attachments.map((f) => `[Attached file: ${f.name}]`).join(' ')
      : ''
    const prompt = fileContext ? `${fileContext}\n${text}` : text

    // Start SSE stream with tool call support
    const controller = startMockSSE(prompt, {
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
      onToolCallStart(toolCall: ToolCall) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            const existing = m.toolCalls || []
            return { ...m, toolCalls: [...existing, toolCall] }
          })
        )
      },
      onToolCallUpdate(toolCall: ToolCall) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            const updated = (m.toolCalls || []).map((tc) =>
              tc.id === toolCall.id ? toolCall : tc
            )
            return { ...m, toolCalls: updated }
          })
        )
      },
    })

    abortRef.current = controller
  }, [input, isStreaming, pendingFiles])

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
      if (msg.role === 'assistant' && idx > 0 && prev[idx - 1].role === 'user') {
        return [...prev.slice(0, idx - 1), ...prev.slice(idx + 1)]
      }
      if (msg.role === 'user' && idx < prev.length - 1 && prev[idx + 1].role === 'assistant') {
        return [...prev.slice(0, idx), ...prev.slice(idx + 2)]
      }
      return prev.filter((m) => m.id !== messageId)
    })
  }, [])

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return
    const lastUserIdx = messages.findLastIndex((m) => m.role === 'user')
    if (lastUserIdx === -1) return

    const userText = messages[lastUserIdx].content
    const newMessages = messages.slice(0, messages.length - 1)

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
      onToolCallStart(toolCall: ToolCall) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            const existing = m.toolCalls || []
            return { ...m, toolCalls: [...existing, toolCall] }
          })
        )
      },
      onToolCallUpdate(toolCall: ToolCall) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            const updated = (m.toolCalls || []).map((tc) =>
              tc.id === toolCall.id ? toolCall : tc
            )
            return { ...m, toolCalls: updated }
          })
        )
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
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  // Drag & drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files)
    }
  }, [handleFilesSelected])

  return (
    <div
      className="flex flex-col h-full relative px-4 py-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/[0.08]">
          <div className="text-center">
            <p className="text-lg font-medium text-accent">
              Drop files here
            </p>
            <p className="text-xs mt-1 text-subtle">
              PDF, XLSX, CSV, DOCX, PPTX
            </p>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="text-4xl mb-3 w-14 h-14 rounded-2xl flex items-center justify-center mx-auto bg-accent text-white">
                P
              </div>
              <h2 className="text-lg font-semibold mb-1 text-foreground">
                Photon Chat
              </h2>
              <p className="text-sm mb-4 text-subtle">
                Send a message to start a conversation
              </p>

              {/* Tool capability hints */}
              <div className="flex flex-wrap gap-2 justify-center max-w-md mx-auto">
                {[
                  { icon: '\u{1F50D}', label: 'Web Search', hint: 'Search for React 19 features' },
                  { icon: '\u{1F50C}', label: 'API Calls', hint: 'Check API status' },
                  { icon: '\u{1F4CE}', label: 'File Upload', hint: 'PDF, XLSX, CSV, DOCX, PPTX' },
                ].map((tool) => (
                  <button
                    key={tool.label}
                    onClick={() => tool.hint.startsWith('PDF') ? fileInputRef.current?.click() : setInput(tool.hint)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs transition-colors cursor-pointer bg-surface border border-border text-muted hover:bg-surface-hover"
                  >
                    <span>{tool.icon}</span>
                    <span>{tool.label}</span>
                  </button>
                ))}
              </div>
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
                  onPreviewFile={setPreviewFile}
                />
              )
            })}

            {/* Streaming indicator */}
            {isStreaming && (
              <div className="px-4 py-2">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce-dot" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce-dot" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce-dot" style={{ animationDelay: '300ms' }} />
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
          className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs transition-opacity cursor-pointer bg-surface text-muted border border-border opacity-0 hover:opacity-100"
        >
          Scroll to bottom
        </button>
      </div>

      {/* Input area */}
      <div className="border-t border-border px-4 py-3">
        {/* Pending file attachments */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pendingFiles.map((f) => (
              <FileChip
                key={f.id}
                file={f}
                onPreview={setPreviewFile}
                onRemove={handleRemovePendingFile}
              />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl px-4 py-3 bg-surface border border-border">
          {/* File upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer text-subtle hover:text-foreground"
            title="Attach file (PDF, Excel, CSV, DOCX, PPTX)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleFilesSelected(e.target.files)
              e.target.value = ''
            }}
          />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Send a message... (try: 'search for React 19')"
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-sm leading-relaxed text-foreground"
            style={{ maxHeight: '200px' }}
          />
          {isStreaming ? (
            <button
              onClick={handleStop}
              className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer bg-priority-urgent text-white"
              title="Stop generating"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() && pendingFiles.length === 0}
              className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 text-white ${
                (input.trim() || pendingFiles.length > 0) ? 'bg-accent' : 'bg-surface-hover'
              }`}
              title="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2L2 8.5L6.5 10L10 6L7 10.5L8.5 14.5L14 2Z" />
              </svg>
            </button>
          )}
        </div>
        <p className="text-center mt-2 text-xs text-subtle">
          Photon AI can make mistakes. Verify important information.
        </p>
      </div>

      {/* File preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
