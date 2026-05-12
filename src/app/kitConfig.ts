export type DeploymentMode = 'local' | 'cloud' | 'onprem'
export type FrontendWorkerRuntime = 'cloudflare-workers' | 'workerd'
export type SyncBackend = 'rust-server' | 'cloudflare-durable-object'
export type AppServerBackend = 'rust-server' | 'external-api'

export interface AppKitConfig {
  app: {
    id: string
    displayName: string
    storageNamespace: string
  }
  workspace: {
    name: string
    initial: string
    primaryNav: Array<{ id: string; label: string; icon: string }>
    projects: Array<{ id: string; label: string }>
    users: string[]
  }
  issues: {
    identifierPrefix: string
    defaultProject: string
  }
  chat: {
    productName: string
    disclaimer: string
  }
  sync: {
    backend: SyncBackend
    yjsArrayName: string
    persistenceKey: string
    websocketPath: string
    websocketUrl?: string
    roomParam: string
  }
  server: {
    backend: AppServerBackend
    apiBaseUrl?: string
    issuesPath: string
  }
  frontendWorker: {
    enabled: true
    runtime: FrontendWorkerRuntime
    healthPath: string
    websocketPath: string
    role: 'frontend-edge-companion'
  }
  storage: {
    themeKey: string
  }
}

function isDeploymentMode(value: string | undefined): value is DeploymentMode {
  return value === 'local' || value === 'cloud' || value === 'onprem'
}

function isSyncBackend(value: string | undefined): value is SyncBackend {
  return value === 'rust-server' || value === 'cloudflare-durable-object'
}

function isAppServerBackend(value: string | undefined): value is AppServerBackend {
  return value === 'rust-server' || value === 'external-api'
}

export function resolveDeploymentMode(value: string | undefined): DeploymentMode {
  return isDeploymentMode(value) ? value : 'local'
}

export function resolveFrontendWorkerRuntime(
  deploymentMode: DeploymentMode,
  value: string | undefined
): FrontendWorkerRuntime {
  if (value === 'workerd' || value === 'cloudflare-workers') return value
  return deploymentMode === 'onprem' ? 'workerd' : 'cloudflare-workers'
}

export function resolveSyncBackend(
  deploymentMode: DeploymentMode,
  value: string | undefined
): SyncBackend {
  if (isSyncBackend(value)) return value
  return deploymentMode === 'cloud' ? 'cloudflare-durable-object' : 'rust-server'
}

export function resolveAppServerBackend(value: string | undefined): AppServerBackend {
  return isAppServerBackend(value) ? value : 'rust-server'
}

export function namespacedKey(namespace: string, suffix: string): string {
  return `${namespace}-${suffix}`
}

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
const deploymentMode = resolveDeploymentMode(viteEnv.VITE_PHOTON_DEPLOYMENT_MODE)
const syncBackend = resolveSyncBackend(deploymentMode, viteEnv.VITE_PHOTON_SYNC_BACKEND)
const frontendWorkerRuntime = resolveFrontendWorkerRuntime(
  deploymentMode,
  viteEnv.VITE_PHOTON_FRONTEND_WORKER_RUNTIME
)
const appProfile = {
  id: 'photon',
  displayName: 'Photon',
  storageNamespace: 'photon',
} as const

export const appKitConfig: AppKitConfig = {
  app: appProfile,
  workspace: {
    name: 'Photon',
    initial: 'P',
    primaryNav: [
      { id: 'my-issues', label: 'My Issues', icon: '👤' },
      { id: 'all-issues', label: 'All Issues', icon: '📋' },
      { id: 'active', label: 'Active', icon: '⚡' },
    ],
    projects: [
      { id: 'photon-core', label: 'Photon Core' },
      { id: 'client-app-kit', label: 'Client App Kit' },
      { id: 'api-gateway', label: 'API Gateway' },
      { id: 'auth-service', label: 'Auth Service' },
    ],
    users: ['田中太郎', '鈴木花子', '佐藤健', '山田美咲', '高橋翔'],
  },
  issues: {
    identifierPrefix: 'PLT',
    defaultProject: 'Client App Kit',
  },
  chat: {
    productName: 'Photon Chat',
    disclaimer: 'Photon AI can make mistakes. Verify important information.',
  },
  sync: {
    backend: syncBackend,
    yjsArrayName: 'issues',
    persistenceKey: namespacedKey(appProfile.storageNamespace, 'issues'),
    websocketPath: '/ws',
    websocketUrl: viteEnv.VITE_PHOTON_SYNC_WS_URL,
    roomParam: 'room',
  },
  server: {
    backend: resolveAppServerBackend(viteEnv.VITE_PHOTON_APP_SERVER_BACKEND),
    apiBaseUrl: viteEnv.VITE_PHOTON_API_BASE_URL,
    issuesPath: '/api/issues',
  },
  frontendWorker: {
    enabled: true,
    runtime: frontendWorkerRuntime,
    healthPath: '/api/health',
    websocketPath: '/ws',
    role: 'frontend-edge-companion',
  },
  storage: {
    themeKey: namespacedKey(appProfile.storageNamespace, 'theme'),
  },
}
