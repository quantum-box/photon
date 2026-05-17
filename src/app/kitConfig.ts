export type DeploymentMode = 'local' | 'cloud' | 'onprem'
export type FrontendWorkerRuntime = 'cloudflare-workers' | 'workerd'
// Photon Live backend: realtime collaborative UX transport for Yjs rooms,
// presence, awareness, and reconnect behavior. Durable mutations belong to
// Photon Engine and are synced through REST/RPC push/pull endpoints.
export type SyncBackend = 'rust-server' | 'cloudflare-durable-object'
export type AppServerBackend = 'rust-server' | 'external-api'
export type ChatStreamMode = 'mock' | 'backend'
export type ChatStreamTransport = 'sse' | 'websocket'
export type WorkflowStageKind = 'start' | 'work' | 'review' | 'end' | 'terminal'
export type WorkflowTransitionKind = 'primary' | 'exception'

export interface WorkflowStageDefinition {
  id: string
  label: string
  description: string
  kind: WorkflowStageKind
}

export interface WorkflowTransitionDefinition {
  id: string
  source: string
  target: string
  label?: string
  kind: WorkflowTransitionKind
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  stages: WorkflowStageDefinition[]
  transitions: WorkflowTransitionDefinition[]
}

export interface RecordDefaultsConfig {
  identifierPrefix: string
  defaultProject: string
}

export interface AppKitConfig {
  app: {
    id: string
    displayName: string
    storageNamespace: string
  }
  tenant: {
    id: string
    name: string
  }
  workspace: {
    id: string
    scope: string
    name: string
    initial: string
    primaryNav: Array<{ id: string; label: string; icon: string }>
    projects: Array<{ id: string; label: string }>
    users: string[]
  }
  records: RecordDefaultsConfig
  workflows: {
    defaultWorkflowId: string
    pgliteDataDir: string
    definitions: WorkflowDefinition[]
  }
  chat: {
    productName: string
    disclaimer: string
    stream: {
      mode: ChatStreamMode
      transport: ChatStreamTransport
      endpoint: string
      websocketUrl?: string
      authToken?: string
      toolResultPath?: string
    }
  }
  docs: {
    pgliteDataDir: string
    defaultTitle: string
    yjsArrayName: string
  }
  engine: {
    pgliteDataDir: string
    pushPath: string
    pullPath: string
  }
  attachments: {
    yjsArrayName: string
    endpoint: string
    acceptedTypes: string
    maxPreviewBytes: number
    webStorageProvider: 'web-object-storage'
    tauriStorageProvider: 'tauri-local-file-cache'
  }
  sync: {
    /**
     * Photon Live configuration.
     *
     * This controls realtime collaborative UX only: Yjs room transport,
     * presence, awareness, local IndexedDB hydration, and reconnect behavior.
     * It is intentionally separate from Photon Engine durable mutation sync.
     */
    backend: SyncBackend
    tenantId: string
    workspaceId: string
    workspaceScope: string
    recordsRoomId: string
    yjsArrayName: string
    databasesArrayName: string
    databaseViewsArrayName: string
    workflowCanvasesMapName: string
    persistenceKey: string
    websocketPath: string
    websocketUrl?: string
    websocketBaseUrl?: string
    roomParam: string
  }
  server: {
    backend: AppServerBackend
    apiBaseUrl?: string
    recordsPath: string
    documentsPath: string
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

function isChatStreamMode(value: string | undefined): value is ChatStreamMode {
  return value === 'mock' || value === 'backend'
}

function isChatStreamTransport(value: string | undefined): value is ChatStreamTransport {
  return value === 'sse' || value === 'websocket'
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

export function resolveChatStreamMode(
  deploymentMode: DeploymentMode,
  value: string | undefined
): ChatStreamMode {
  if (isChatStreamMode(value)) return value
  return deploymentMode === 'local' ? 'mock' : 'backend'
}

export function resolveChatStreamTransport(value: string | undefined): ChatStreamTransport {
  return isChatStreamTransport(value) ? value : 'sse'
}

export function namespacedKey(namespace: string, suffix: string): string {
  return `${namespace}-${suffix}`
}

/**
 * Build a tenant-scoped workspace id for durable Photon Engine records and
 * realtime Photon Live rooms.
 */
export function buildWorkspaceScope(tenantId: string, workspaceId: string): string {
  return `tenant:${tenantId}:workspace:${workspaceId}`
}

function namespacedDataDir(base: string, workspaceScope: string): string {
  return `${base}-${workspaceScope.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

/**
 * Build a sync relay room id following the multi-tenant convention
 * `tenant:{tenantId}:workspace:{workspaceId}:{surface}`.
 *
 * `surface` is the in-workspace collection name. For composite surfaces such
 * as `doc:{docId}` or `chat:{threadId}`, callers pass the full segment, e.g.
 * `buildRoomId(scope, 'doc:42')`.
 */
export function buildRoomId(workspaceScope: string, surface: string): string {
  return `${workspaceScope}:${surface}`
}

function appendRoomQuery(base: string, roomId: string): string {
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}room=${roomId}`
}

export function buildSyncWebsocketPath(roomId: string): string {
  return appendRoomQuery('/ws', roomId)
}

export function buildConfiguredSyncWebsocketUrl(roomId: string): string | undefined {
  return websocketBaseUrl ? appendRoomQuery(websocketBaseUrl, roomId) : undefined
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
const DEFAULT_TENANT_ID = 'photon'
const DEFAULT_WORKSPACE_ID = 'photon-default'
const tenantId = viteEnv.VITE_PHOTON_TENANT_ID ?? DEFAULT_TENANT_ID
const tenantName = viteEnv.VITE_PHOTON_TENANT_NAME ?? 'Photon'
const workspaceId = viteEnv.VITE_PHOTON_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID
const workspaceName = viteEnv.VITE_PHOTON_WORKSPACE_NAME ?? 'Photon'
const workspaceScope = buildWorkspaceScope(tenantId, workspaceId)
const recordsRoomId = buildRoomId(workspaceScope, 'records')
const syncWebsocketPath = appendRoomQuery('/ws', recordsRoomId)
const websocketBaseUrl = viteEnv.VITE_PHOTON_SYNC_WS_URL
const chatStreamEndpoint = viteEnv.VITE_PHOTON_AGENT_STREAM_URL ?? '/api/agent/chat/stream'

export const appKitConfig: AppKitConfig = {
  app: appProfile,
  tenant: {
    id: tenantId,
    name: tenantName,
  },
  workspace: {
    id: workspaceId,
    scope: workspaceScope,
    name: workspaceName,
    initial: 'P',
    primaryNav: [
      { id: 'my-records', label: 'My Records', icon: '👤' },
      { id: 'all-records', label: 'All Records', icon: '📋' },
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
  records: {
    identifierPrefix: 'PLT',
    defaultProject: 'Client App Kit',
  },
  workflows: {
    defaultWorkflowId: 'default-record-workflow',
    pgliteDataDir: namespacedDataDir('idb://photon-workflows', workspaceScope),
    definitions: [
      {
        id: 'default-record-workflow',
        name: 'Default Record Workflow',
        description: 'Default business flow for Photon records.',
        stages: [
          {
            id: 'intake',
            label: 'Intake',
            description: 'Capture and triage incoming work.',
            kind: 'start',
          },
          {
            id: 'ready',
            label: 'Ready',
            description: 'Work that is ready to start.',
            kind: 'work',
          },
          {
            id: 'execution',
            label: 'Execution',
            description: 'Active implementation or investigation.',
            kind: 'work',
          },
          {
            id: 'validation',
            label: 'Validation',
            description: 'Review, QA, and acceptance checks.',
            kind: 'review',
          },
          {
            id: 'completed',
            label: 'Completed',
            description: 'Work that has shipped or been accepted.',
            kind: 'end',
          },
          {
            id: 'cancelled',
            label: 'Cancelled',
            description: 'Work intentionally stopped or superseded.',
            kind: 'terminal',
          },
        ],
        transitions: [
          { id: 'intake-ready', source: 'intake', target: 'ready', kind: 'primary' },
          { id: 'ready-execution', source: 'ready', target: 'execution', kind: 'primary' },
          { id: 'execution-validation', source: 'execution', target: 'validation', kind: 'primary' },
          { id: 'validation-completed', source: 'validation', target: 'completed', kind: 'primary' },
          { id: 'ready-cancelled', source: 'ready', target: 'cancelled', label: 'Stop', kind: 'exception' },
          { id: 'execution-cancelled', source: 'execution', target: 'cancelled', label: 'Stop', kind: 'exception' },
          { id: 'validation-cancelled', source: 'validation', target: 'cancelled', label: 'Stop', kind: 'exception' },
        ],
      },
    ],
  },
  chat: {
    productName: 'Photon Chat',
    disclaimer: 'Photon AI can make mistakes. Verify important information.',
    stream: {
      mode: resolveChatStreamMode(deploymentMode, viteEnv.VITE_PHOTON_CHAT_STREAM_MODE),
      transport: resolveChatStreamTransport(viteEnv.VITE_PHOTON_CHAT_STREAM_TRANSPORT),
      endpoint: chatStreamEndpoint,
      websocketUrl: viteEnv.VITE_PHOTON_AGENT_WS_URL,
      authToken: viteEnv.VITE_PHOTON_AGENT_AUTH_TOKEN,
      toolResultPath: viteEnv.VITE_PHOTON_AGENT_TOOL_RESULT_PATH ?? '/api/agent/tool-results',
    },
  },
  docs: {
    pgliteDataDir: namespacedDataDir('idb://photon-docs', workspaceScope),
    defaultTitle: 'Untitled doc',
    yjsArrayName: 'blocks',
  },
  engine: {
    pgliteDataDir: namespacedDataDir('idb://photon-engine', workspaceScope),
    pushPath: '/api/engine/push',
    pullPath: '/api/engine/pull',
  },
  attachments: {
    yjsArrayName: 'attachments',
    endpoint: '/api/attachments',
    acceptedTypes: '.pdf,.xlsx,.xls,.csv,.docx,.pptx',
    maxPreviewBytes: 25 * 1024 * 1024,
    webStorageProvider: 'web-object-storage',
    tauriStorageProvider: 'tauri-local-file-cache',
  },
  sync: {
    backend: syncBackend,
    tenantId,
    workspaceId,
    workspaceScope,
    recordsRoomId,
    yjsArrayName: 'records',
    databasesArrayName: 'databases',
    databaseViewsArrayName: 'databaseViews',
    workflowCanvasesMapName: 'workflowCanvases',
    persistenceKey: recordsRoomId,
    websocketPath: buildSyncWebsocketPath(recordsRoomId),
    websocketUrl: buildConfiguredSyncWebsocketUrl(recordsRoomId),
    websocketBaseUrl,
    roomParam: 'room',
  },
  server: {
    backend: resolveAppServerBackend(viteEnv.VITE_PHOTON_APP_SERVER_BACKEND),
    apiBaseUrl: viteEnv.VITE_PHOTON_API_BASE_URL,
    recordsPath: '/api/records',
    documentsPath: '/api/documents',
  },
  frontendWorker: {
    enabled: true,
    runtime: frontendWorkerRuntime,
    healthPath: '/api/health',
    websocketPath: syncWebsocketPath,
    role: 'frontend-edge-companion',
  },
  storage: {
    themeKey: namespacedKey(appProfile.storageNamespace, 'theme'),
  },
}
