export interface AppKitConfig {
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
    yjsArrayName: string
    persistenceKey: string
    websocketPath: string
    websocketUrl?: string
  }
  server: {
    apiBaseUrl?: string
    issuesPath: string
  }
  storage: {
    themeKey: string
  }
}

export const appKitConfig: AppKitConfig = {
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
    yjsArrayName: 'issues',
    persistenceKey: 'photon-issues',
    websocketPath: '/ws',
    websocketUrl: import.meta.env.VITE_PHOTON_SYNC_WS_URL,
  },
  server: {
    apiBaseUrl: import.meta.env.VITE_PHOTON_API_BASE_URL,
    issuesPath: '/api/issues',
  },
  storage: {
    themeKey: 'photon-theme',
  },
}
