import { createRoute } from '@tanstack/react-router'
import { EngineSyncDashboard } from '../components/sync/EngineSyncDashboard'
import { rootRoute } from './root'

export const syncRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sync',
  component: EngineSyncDashboard,
})
