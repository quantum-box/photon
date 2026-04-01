import { useState, useEffect, useSyncExternalStore } from 'react'

/**
 * A tiny external store for the streaming animation state.
 * This avoids React compiler issues with refs-in-render and setState-in-effects.
 */
class StreamingStore {
  private target = ''
  private displayed = ''
  private raf: number | null = null
  private lastTick = 0
  private listeners = new Set<() => void>()
  private charsPerTick: number
  private tickMs: number

  constructor(charsPerTick = 3, tickMs = 16) {
    this.charsPerTick = charsPerTick
    this.tickMs = tickMs
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this.displayed

  private notify() {
    for (const l of this.listeners) l()
  }

  private tick = (now: number) => {
    if (this.displayed.length >= this.target.length) {
      this.raf = null
      return
    }

    if (now - this.lastTick >= this.tickMs) {
      const remaining = this.target.length - this.displayed.length
      const burst = remaining > 60
        ? this.charsPerTick * 4
        : remaining > 20
          ? this.charsPerTick * 2
          : this.charsPerTick
      this.displayed = this.target.slice(0, this.displayed.length + burst)
      this.lastTick = now
      this.notify()
    }

    this.raf = requestAnimationFrame(this.tick)
  }

  setTarget(text: string, streaming: boolean) {
    this.target = text

    if (!streaming) {
      // Show full text immediately
      if (this.raf) {
        cancelAnimationFrame(this.raf)
        this.raf = null
      }
      if (this.displayed !== text) {
        this.displayed = text
        this.notify()
      }
      return
    }

    // Start animation if not running and there's text to reveal
    if (!this.raf && this.displayed.length < text.length) {
      this.raf = requestAnimationFrame(this.tick)
    }
  }

  reset() {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
    this.target = ''
    this.displayed = ''
    this.notify()
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.listeners.clear()
  }
}

/**
 * Hook that smoothly reveals text character-by-character with adaptive speed.
 * Uses useSyncExternalStore for React compiler compatibility.
 */
export function useStreamingText(
  fullText: string,
  isStreaming: boolean,
  charsPerTick = 3,
  tickMs = 16
) {
  const [store] = useState(() => new StreamingStore(charsPerTick, tickMs))
  const displayed = useSyncExternalStore(store.subscribe, store.getSnapshot)

  useEffect(() => {
    store.setTarget(fullText, isStreaming)
  }, [store, fullText, isStreaming])

  useEffect(() => {
    return () => store.destroy()
  }, [store])

  return displayed
}
