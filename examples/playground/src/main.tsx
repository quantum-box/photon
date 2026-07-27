import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { router } from './router'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider } from './contexts/AuthContext'
import { seedPlaygroundData } from './lib/recordsApi'

/**
 * Demo data is playground scaffolding, not engine behavior, so it is seeded
 * here rather than fabricated by a read path.
 *
 * Awaited before the first render on purpose: the records context reads the
 * engine once on mount, and a seed still in flight at that moment leaves the
 * app permanently empty until a reload.
 */
async function seedIfWanted(): Promise<void> {
  if (!import.meta.env.DEV) return
  if (import.meta.env.VITE_PHOTON_SEED_DEMO_DATA === 'false') return
  try {
    await seedPlaygroundData()
  } catch (error) {
    console.warn('Failed to seed playground demo data', error)
  }
}

void seedIfWanted().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ThemeProvider>
    </StrictMode>,
  )
})
