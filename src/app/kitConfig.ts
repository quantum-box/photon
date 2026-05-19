export type DeploymentMode = 'local' | 'cloud' | 'onprem'
export type FrontendWorkerRuntime = 'cloudflare-workers' | 'workerd'
// Photon Live backend: realtime collaborative UX transport for Yjs rooms,
// presence, awareness, and reconnect behavior. Durable mutations belong to
// Photon Engine and are synced through REST/RPC push/pull endpoints.
export type SyncBackend = 'rust-server' | 'cloudflare-durable-object'
export type AppServerBackend = 'rust-server' | 'external-api'
export type AuthTransport = 'rest' | 'graphql'
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

export interface TenantWorkspaceOption {
  tenantId: string
  tenantName: string
  workspaceId: string
  workspaceName: string
  workspaceInitial: string
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
  tenancy: {
    availableWorkspaces: TenantWorkspaceOption[]
    selectionStorageKey: string
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
  library: {
    apiBaseUrl?: string
    serviceToken?: string
  }
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
  auth: {
    enabled: boolean
    transport: AuthTransport
    apiBaseUrl?: string
    restPath: string
    passwordPath: string
    graphqlPath: string
    mutationName: string
    graphqlSelection: string
    platformId?: string
    providerId?: string
    tenantId?: string
    operatorId?: string
    tokenStorageKey: string
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

function isAuthTransport(value: string | undefined): value is AuthTransport {
  return value === 'rest' || value === 'graphql'
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

export function resolveAuthTransport(value: string | undefined): AuthTransport {
  return isAuthTransport(value) ? value : 'rest'
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

function normalizeInitial(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (trimmed) return trimmed.slice(0, 1).toUpperCase()
  return fallback.slice(0, 1).toUpperCase() || 'P'
}

function normalizeTenantWorkspaceOption(
  value: Partial<TenantWorkspaceOption>,
  fallback: TenantWorkspaceOption
): TenantWorkspaceOption {
  const tenantId = value.tenantId?.trim() || fallback.tenantId
  const workspaceId = value.workspaceId?.trim() || fallback.workspaceId
  const tenantName = value.tenantName?.trim() || tenantId
  const workspaceName = value.workspaceName?.trim() || workspaceId
  return {
    tenantId,
    tenantName,
    workspaceId,
    workspaceName,
    workspaceInitial: normalizeInitial(value.workspaceInitial, workspaceName),
  }
}

export function resolveTenantWorkspaceOptions(
  rawValue: string | undefined,
  fallback: TenantWorkspaceOption
): TenantWorkspaceOption[] {
  if (!rawValue?.trim()) return [fallback]

  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!Array.isArray(parsed)) return [fallback]
    const options = parsed
      .filter((value): value is Partial<TenantWorkspaceOption> =>
        Boolean(value && typeof value === 'object')
      )
      .map((value) => normalizeTenantWorkspaceOption(value, fallback))
    return options.length > 0 ? options : [fallback]
  } catch {
    return [fallback]
  }
}

export function resolveTenantWorkspaceSelection(
  options: TenantWorkspaceOption[],
  tenantId: string | undefined,
  workspaceId: string | undefined
): TenantWorkspaceOption {
  const fallback = options[0]
  return options.find((option) =>
    option.tenantId === tenantId && option.workspaceId === workspaceId
  ) ?? fallback
}

function browserSelection(storageKey: string): { tenantId?: string; workspaceId?: string } {
  if (typeof window === 'undefined') return {}

  const url = new URL(window.location.href)
  const fromUrl = {
    tenantId: url.searchParams.get('tenant_id') ?? undefined,
    workspaceId: url.searchParams.get('workspace_id') ?? undefined,
  }
  if (fromUrl.tenantId || fromUrl.workspaceId) return fromUrl

  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as { tenantId?: string; workspaceId?: string }
    return {
      tenantId: parsed.tenantId,
      workspaceId: parsed.workspaceId,
    }
  } catch {
    return {}
  }
}

export function switchTenantWorkspace(option: TenantWorkspaceOption): void {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(
    appKitConfig.tenancy.selectionStorageKey,
    JSON.stringify({ tenantId: option.tenantId, workspaceId: option.workspaceId })
  )
  const url = new URL(window.location.href)
  url.searchParams.set('tenant_id', option.tenantId)
  url.searchParams.set('workspace_id', option.workspaceId)
  window.location.assign(url)
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
const tenantSelectionStorageKey = namespacedKey(appProfile.storageNamespace, 'tenant-workspace')
const defaultTenantWorkspace = normalizeTenantWorkspaceOption(
  {
    tenantId: viteEnv.VITE_PHOTON_TENANT_ID ?? DEFAULT_TENANT_ID,
    tenantName: viteEnv.VITE_PHOTON_TENANT_NAME ?? 'Photon',
    workspaceId: viteEnv.VITE_PHOTON_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID,
    workspaceName: viteEnv.VITE_PHOTON_WORKSPACE_NAME ?? 'Photon',
    workspaceInitial: viteEnv.VITE_PHOTON_WORKSPACE_INITIAL,
  },
  {
    tenantId: DEFAULT_TENANT_ID,
    tenantName: 'Photon',
    workspaceId: DEFAULT_WORKSPACE_ID,
    workspaceName: 'Photon',
    workspaceInitial: 'P',
  }
)
const availableTenantWorkspaces = resolveTenantWorkspaceOptions(
  viteEnv.VITE_PHOTON_TENANT_WORKSPACES,
  defaultTenantWorkspace
)
const requestedTenantWorkspace = browserSelection(tenantSelectionStorageKey)
const selectedTenantWorkspace = resolveTenantWorkspaceSelection(
  availableTenantWorkspaces,
  requestedTenantWorkspace.tenantId,
  requestedTenantWorkspace.workspaceId
)
const tenantId = selectedTenantWorkspace.tenantId
const tenantName = selectedTenantWorkspace.tenantName
const workspaceId = selectedTenantWorkspace.workspaceId
const workspaceName = selectedTenantWorkspace.workspaceName
const workspaceScope = buildWorkspaceScope(tenantId, workspaceId)
const recordsRoomId = buildRoomId(workspaceScope, 'records')
const syncWebsocketPath = appendRoomQuery('/ws', recordsRoomId)
const websocketBaseUrl = viteEnv.VITE_PHOTON_SYNC_WS_URL
const chatStreamEndpoint = viteEnv.VITE_PHOTON_AGENT_STREAM_URL ?? '/api/agent/chat/stream'
const photonApiBaseUrl = viteEnv.VITE_PHOTON_API_BASE_URL

export const appKitConfig: AppKitConfig = {
  app: appProfile,
  tenant: {
    id: tenantId,
    name: tenantName,
  },
  tenancy: {
    availableWorkspaces: availableTenantWorkspaces,
    selectionStorageKey: tenantSelectionStorageKey,
  },
  workspace: {
    id: workspaceId,
    scope: workspaceScope,
    name: workspaceName,
    initial: selectedTenantWorkspace.workspaceInitial,
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
    apiBaseUrl: photonApiBaseUrl,
    recordsPath: '/api/records',
    documentsPath: '/api/documents',
  },
  auth: {
    enabled: viteEnv.VITE_PHOTON_AUTH_ENABLED === 'true',
    transport: resolveAuthTransport(viteEnv.VITE_PHOTON_AUTH_TRANSPORT),
    apiBaseUrl: viteEnv.VITE_PHOTON_AUTH_API_BASE_URL ?? photonApiBaseUrl,
    restPath: viteEnv.VITE_PHOTON_AUTH_REST_PATH ?? '/auth/v1beta/sign-in-with-platform',
    passwordPath: viteEnv.VITE_PHOTON_AUTH_PASSWORD_PATH ?? '/auth/v1beta/sign-in-with-password',
    graphqlPath: viteEnv.VITE_PHOTON_AUTH_GRAPHQL_PATH ?? '/graphql',
    mutationName: viteEnv.VITE_PHOTON_AUTH_GRAPHQL_MUTATION ?? 'sign_in_with_platform',
    graphqlSelection: viteEnv.VITE_PHOTON_AUTH_GRAPHQL_SELECTION
      ?? 'token expires_at user { id email name }',
    platformId: viteEnv.VITE_PHOTON_AUTH_PLATFORM_ID,
    providerId: viteEnv.VITE_PHOTON_AUTH_PROVIDER_ID,
    tenantId: viteEnv.VITE_PHOTON_AUTH_TENANT_ID ?? tenantId,
    operatorId: viteEnv.VITE_PHOTON_OPERATOR_ID,
    tokenStorageKey: viteEnv.VITE_PHOTON_AUTH_TOKEN_STORAGE_KEY
      ?? namespacedKey(appProfile.storageNamespace, 'auth-session'),
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
  library: {
    apiBaseUrl: viteEnv.VITE_LIBRARY_API_URL,
    serviceToken: viteEnv.VITE_LIBRARY_SERVICE_TOKEN,
  },
}
