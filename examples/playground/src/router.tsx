import { createRouter } from '@tanstack/react-router'
import { indexRoute, loginRoute, rootRoute } from './routes/root'
import {
  databasesRoute,
  kanbanRoute,
  legacyKanbanRoute,
  recordDetailRoute,
  recordsIndexRoute,
  workflowRoute,
} from './routes/databases'
import { chatRoute } from './routes/chat'
import { syncRoute } from './routes/sync'
import { docsRoute, documentDetailRoute } from './routes/docs'
import { libraryDataRoute, libraryOrgRepoRoute, libraryRoute } from './routes/library'

// ── Route Tree & Router ───────────────────────────────────────

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  databasesRoute.addChildren([recordsIndexRoute, recordDetailRoute]),
  kanbanRoute,
  workflowRoute,
  legacyKanbanRoute,
  chatRoute,
  syncRoute,
  docsRoute,
  documentDetailRoute,
  libraryRoute,
  libraryOrgRepoRoute,
  libraryDataRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
