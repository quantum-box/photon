export interface AppKitConfig {
  workspace: {
    id: string
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
  docs: {
    pgliteDataDir: string
    defaultTitle: string
    yjsArrayName: string
  }
  sync: {
    workspaceId: string
    issuesRoomId: string
    yjsArrayName: string
    persistenceKey: string
    websocketPath: string
    websocketUrl?: string
    websocketBaseUrl?: string
  }
  server: {
    apiBaseUrl?: string
    issuesPath: string
  }
  storage: {
    themeKey: string
  }
}

const DEFAULT_WORKSPACE_ID = 'photon-default'

/**
 * Build a sync relay room id following the convention recorded in
 * ADR-0001: `workspace:{workspaceId}:{surface}`.
 *
 * `surface` is the in-workspace collection name. For composite surfaces such
 * as `doc:{docId}` or `chat:{threadId}`, callers pass the full segment, e.g.
 * `buildRoomId(ws, 'doc:42')`.
 */
export function buildRoomId(workspaceId: string, surface: string): string {
  return `workspace:${workspaceId}:${surface}`
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

const issuesRoomId = buildRoomId(DEFAULT_WORKSPACE_ID, 'issues')
const websocketBaseUrl = import.meta.env.VITE_PHOTON_SYNC_WS_URL as string | undefined

export const appKitConfig: AppKitConfig = {
  workspace: {
    id: DEFAULT_WORKSPACE_ID,
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
  docs: {
    pgliteDataDir: 'idb://photon-docs',
    defaultTitle: 'Untitled doc',
    yjsArrayName: 'blocks',
  },
  sync: {
    workspaceId: DEFAULT_WORKSPACE_ID,
    issuesRoomId,
    yjsArrayName: 'issues',
    persistenceKey: issuesRoomId,
    websocketPath: buildSyncWebsocketPath(issuesRoomId),
    websocketUrl: buildConfiguredSyncWebsocketUrl(issuesRoomId),
    websocketBaseUrl,
  },
  server: {
    apiBaseUrl: import.meta.env.VITE_PHOTON_API_BASE_URL,
    issuesPath: '/api/issues',
  },
  storage: {
    themeKey: 'photon-theme',
  },
}
