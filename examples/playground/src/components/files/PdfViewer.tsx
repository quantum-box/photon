import { useState, useEffect, useRef, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

interface PdfViewerProps {
  url: string
  name: string
}

export function PdfViewer({ url, name }: PdfViewerProps) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1.2)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    const loadTask = pdfjsLib.getDocument(url)
    loadTask.promise
      .then((doc) => {
        if (cancelled) return
        setPdf(doc)
        setTotalPages(doc.numPages)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
      loadTask.destroy()
    }
  }, [url])

  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current) return
    const page = await pdf.getPage(currentPage)
    const viewport = page.getViewport({ scale })
    const canvas = canvasRef.current
    canvas.height = viewport.height
    canvas.width = viewport.width
    const ctx = canvas.getContext('2d')!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx, viewport, canvas } as any).promise
  }, [pdf, currentPage, scale])

  useEffect(() => {
    renderPage()
  }, [renderPage])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-priority-urgent">
        <p>Failed to load PDF: {error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0 bg-surface">
        <span className="text-xs font-medium truncate mr-2 text-muted">
          {name}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
            className="px-2 py-0.5 rounded text-xs cursor-pointer bg-surface-hover text-muted"
          >
            -
          </button>
          <span className="text-xs text-subtle">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, s + 0.2))}
            className="px-2 py-0.5 rounded text-xs cursor-pointer bg-surface-hover text-muted"
          >
            +
          </button>
          <span className="mx-2 text-xs text-border">|</span>
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="px-2 py-0.5 rounded text-xs cursor-pointer disabled:opacity-30 bg-surface-hover text-muted"
          >
            Prev
          </button>
          <span className="text-xs text-muted">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="px-2 py-0.5 rounded text-xs cursor-pointer disabled:opacity-30 bg-surface-hover text-muted"
          >
            Next
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 overflow-auto flex justify-center p-4 bg-canvas">
        {pdf ? (
          <canvas ref={canvasRef} className="shadow-lg" style={{ maxWidth: '100%', height: 'auto' }} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="flex gap-1">
              <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
