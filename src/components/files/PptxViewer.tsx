import { useState, useEffect } from 'react'

interface PptxViewerProps {
  file: File
  name: string
}

interface SlideInfo {
  index: number
  texts: string[]
}

export function PptxViewer({ file, name }: PptxViewerProps) {
  const [slides, setSlides] = useState<SlideInfo[]>([])
  const [activeSlide, setActiveSlide] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    file.arrayBuffer().then((buffer) => {
      if (cancelled) return
      try {
        const decoder = new TextDecoder()
        const text = decoder.decode(new Uint8Array(buffer))
        const slideTexts: SlideInfo[] = []

        // Simple PPTX text extractor - find text between <a:t> tags
        const textMatches = text.match(/<a:t>([^<]*)<\/a:t>/g)
        if (textMatches) {
          const allTexts = textMatches.map((m) => m.replace(/<\/?a:t>/g, ''))
          const chunkSize = Math.max(3, Math.ceil(allTexts.length / 10))
          for (let i = 0; i < allTexts.length; i += chunkSize) {
            slideTexts.push({
              index: slideTexts.length + 1,
              texts: allTexts.slice(i, i + chunkSize),
            })
          }
        }

        if (slideTexts.length === 0) {
          slideTexts.push({ index: 1, texts: ['(No text content extracted)'] })
        }

        setSlides(slideTexts)
      } catch {
        setSlides([{ index: 1, texts: [`Presentation: ${file.name}`, `Size: ${(file.size / 1024).toFixed(1)} KB`] }])
      }
    }).catch((err) => {
      if (!cancelled) setError(err.message)
    })
    return () => { cancelled = true }
  }, [file])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-priority-urgent">
        <p>Failed to load presentation: {error}</p>
      </div>
    )
  }

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    )
  }

  const slide = slides[activeSlide]

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0 bg-surface">
        <span className="text-xs font-medium truncate mr-2 text-muted">
          {name}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveSlide((s) => Math.max(0, s - 1))}
            disabled={activeSlide <= 0}
            className="px-2 py-0.5 rounded text-xs cursor-pointer disabled:opacity-30 bg-surface-hover text-muted"
          >
            Prev
          </button>
          <span className="text-xs text-muted">
            Slide {activeSlide + 1} / {slides.length}
          </span>
          <button
            onClick={() => setActiveSlide((s) => Math.min(slides.length - 1, s + 1))}
            disabled={activeSlide >= slides.length - 1}
            className="px-2 py-0.5 rounded text-xs cursor-pointer disabled:opacity-30 bg-surface-hover text-muted"
          >
            Next
          </button>
        </div>
      </div>

      {/* Slide content */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-6 bg-canvas">
        <div
          className="rounded-lg shadow-xl p-8 bg-surface border border-border flex flex-col justify-center items-center"
          style={{
            width: '100%',
            maxWidth: 720,
            aspectRatio: '16 / 9',
          }}
        >
          {slide.texts.map((text, i) => (
            <p
              key={i}
              className="mb-2 text-center text-foreground"
              style={{
                fontSize: i === 0 ? '1.25rem' : '0.875rem',
                fontWeight: i === 0 ? 600 : 400,
              }}
            >
              {text}
            </p>
          ))}
        </div>
      </div>

      {/* Slide thumbnails */}
      {slides.length > 1 && (
        <div className="flex gap-2 px-4 py-2 overflow-x-auto border-t border-border flex-shrink-0 bg-surface">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveSlide(i)}
              className={`flex-shrink-0 rounded px-3 py-2 text-xs cursor-pointer transition-colors ${
                i === activeSlide
                  ? 'bg-accent text-white'
                  : 'bg-surface-hover text-subtle'
              }`}
              style={{ minWidth: 60 }}
            >
              {s.index}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
