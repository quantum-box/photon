import { useRef, useCallback, useEffect } from 'react'

/**
 * Auto-scroll hook that follows new content unless user has scrolled up.
 * Re-engages auto-scroll when user scrolls back near the bottom.
 */
export function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const threshold = 80 // px from bottom to consider "at bottom"

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    })
  }, [])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    userScrolledRef.current = distFromBottom > threshold
  }, [])

  // Auto-scroll when deps change (new content)
  useEffect(() => {
    if (!userScrolledRef.current) {
      scrollToBottom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { containerRef, handleScroll, scrollToBottom }
}
