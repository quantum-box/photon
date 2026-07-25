import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { router } from './router'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider } from './contexts/AuthContext'
import { seedPlaygroundData } from './lib/recordsApi'

// Demo data is playground scaffolding, not engine behavior. It is seeded here
// explicitly at bootstrap so no read path ever fabricates records.
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
