/* eslint-disable react-refresh/only-export-components */
import { createRoute, useMatch } from '@tanstack/react-router'
import { DocsView } from '../components/docs/DocsView'
import { rootRoute } from './root'

export const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'docs',
  component: DocsPage,
})

export const documentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'documents/$documentId',
  component: DocsPage,
})

function DocsPage() {
  const detailMatch = useMatch({
    from: documentDetailRoute.id,
    shouldThrow: false,
  })
  const selectedDocId = (detailMatch?.params as { documentId?: string })?.documentId ?? null

  return <DocsView selectedDocId={selectedDocId} />
}
