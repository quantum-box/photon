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
 * Started, not awaited: blocking the first paint on a dozen durable writes
 * delays every page load. The records context awaits the same promise before
 * it hydrates, which is the only place the ordering actually matters.
 */
if (import.meta.env.DEV && import.meta.env.VITE_PHOTON_SEED_DEMO_DATA !== 'false') {
  void seedPlaygroundData().catch((error: unknown) => {
    console.warn('Failed to seed playground demo data', error)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)
