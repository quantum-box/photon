import { useState, useEffect } from 'react'
import mammoth from 'mammoth'

interface DocxViewerProps {
  file: File
  name: string
}

export function DocxViewer({ file, name }: DocxViewerProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    file.arrayBuffer().then((buffer) => {
      if (cancelled) return
      return mammoth.convertToHtml({ arrayBuffer: buffer })
    }).then((result) => {
      if (cancelled || !result) return
      setHtml(result.value)
    }).catch((err) => {
      if (!cancelled) setError(err.message)
    })
    return () => { cancelled = true }
  }, [file])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--priority-urgent)' }}>
        <p>Failed to load document: {error}</p>
      </div>
    )
  }

  if (html === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full animate-bounce-dot" style={{ background: 'var(--accent)', animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full animate-bounce-dot" style={{ background: 'var(--accent)', animationDelay: '150ms' }} />
          <span className="w-2 h-2 rounded-full animate-bounce-dot" style={{ background: 'var(--accent)', animationDelay: '300ms' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center px-4 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--border-color)', background: 'var(--bg-surface)' }}
      >
        <span className="text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
          {name}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div
          className="docx-content max-w-3xl mx-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}
