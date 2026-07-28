import { createRootRoute, createRoute, Outlet, redirect, useNavigate, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { Sidebar } from '../components/Sidebar'
import { LoginPage } from '../components/auth/LoginPage'
import { DatabaseRecordsProvider } from '../contexts/RecordsContext'
import { DatabasesProvider } from '../contexts/DatabasesContext'
import { DatabaseViewsProvider } from '../contexts/DatabaseViewsContext'
import { AttachmentsProvider } from '../lib/attachments/useWorkspaceAttachments'
import { useAuth } from '../contexts/AuthContext'
import { CreateModalContext } from './createModal'
import { KeyboardShortcutsPanel, useGlobalKeyboardShortcuts } from './shortcuts'

export const rootRoute = createRootRoute({
  component: function RootLayout() {
    const [createModalOpen, setCreateModalOpen] = useState(false)
    const { shortcutsOpen, closeShortcuts } = useGlobalKeyboardShortcuts(setCreateModalOpen)
    const auth = useAuth()
    const pathname = useRouterState({ select: (s) => s.location.pathname })
    const navigate = useNavigate()
    if (auth.enabled && !auth.isAuthenticated && pathname !== '/login') {
      return <LoginPage onSignedIn={() => void navigate({ to: '/databases' })} />
    }
    return (
      <DatabaseRecordsProvider>
        <DatabasesProvider>
          <DatabaseViewsProvider>
            <AttachmentsProvider>
              <CreateModalContext.Provider value={{ open: createModalOpen, setOpen: setCreateModalOpen }}>
                <div className="flex h-full min-w-0 flex-col overflow-hidden md:flex-row">
                  <Sidebar />
                  <Outlet />
                </div>
                <KeyboardShortcutsPanel open={shortcutsOpen} onClose={closeShortcuts} />
              </CreateModalContext.Provider>
            </AttachmentsProvider>
          </DatabaseViewsProvider>
        </DatabasesProvider>
      </DatabaseRecordsProvider>
    )
  },
})

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: function LoginRoute() {
    const navigate = useNavigate()
    return <LoginPage onSignedIn={() => void navigate({ to: '/databases' })} />
  },
})

// ── Index Route (redirect → /databases) ───────────────────────

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/databases' })
  },
})
