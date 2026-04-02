/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const STORAGE_KEY = 'tachyon-theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? getSystemTheme() : mode
}

function loadSavedMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return 'dark'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(loadSavedMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(loadSavedMode())
  )

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode)
    localStorage.setItem(STORAGE_KEY, newMode)
  }, [])

  // Update resolved theme when mode changes or system preference changes
  useEffect(() => {
    const update = () => setResolved(resolveTheme(mode))
    update()

    if (mode === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }
  }, [mode])

  // Apply data-theme attribute to <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
  }, [resolved])

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
