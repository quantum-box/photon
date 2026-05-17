import { describe, expect, it } from 'vitest'
import {
  appKitConfig,
  buildRoomId,
  buildSyncWebsocketPath,
  namespacedKey,
  resolveAppServerBackend,
  resolveChatStreamMode,
  resolveChatStreamTransport,
  resolveDeploymentMode,
  resolveFrontendWorkerRuntime,
  resolveSyncBackend,
} from './kitConfig'

describe('appKitConfig', () => {
  it('defines the project-specific extension points for the client app kit', () => {
    expect(appKitConfig.app.id).toBe('photon')
    expect(appKitConfig.app.storageNamespace).toBe('photon')
    expect(appKitConfig.workspace.name).toBe('Photon')
    expect(appKitConfig.workspace.initial).toHaveLength(1)
    expect(appKitConfig.workspace.id).toBe('photon-default')
    expect(appKitConfig.workspace.primaryNav.length).toBeGreaterThan(0)
    expect(appKitConfig.workspace.projects.length).toBeGreaterThan(0)
    expect(appKitConfig.workspace.users.length).toBeGreaterThan(0)
  })

  it('keeps runtime storage and sync keys explicit', () => {
    expect(appKitConfig.storage.themeKey).toBe('photon-theme')
    expect(appKitConfig.sync.backend).toBe('rust-server')
    expect(appKitConfig.sync.workspaceId).toBe('photon-default')
    expect(appKitConfig.sync.recordsRoomId).toBe('workspace:photon-default:records')
    expect(appKitConfig.sync.persistenceKey).toBe('workspace:photon-default:records')
    expect(appKitConfig.sync.yjsArrayName).toBe('records')
    expect(appKitConfig.sync.databasesArrayName).toBe('databases')
    expect(appKitConfig.sync.workflowCanvasesMapName).toBe('workflowCanvases')
    expect(appKitConfig.sync.websocketPath).toBe('/ws?room=workspace:photon-default:records')
    expect(appKitConfig.workflows.pgliteDataDir).toBe('idb://photon-workflows')
    expect(appKitConfig.docs.pgliteDataDir).toBe('idb://photon-docs')
    expect(appKitConfig.engine.pgliteDataDir).toBe('idb://photon-engine')
    expect(appKitConfig.engine.pushPath).toBe('/api/engine/push')
    expect(appKitConfig.engine.pullPath).toBe('/api/engine/pull')
    expect(appKitConfig.docs.yjsArrayName).toBe('blocks')
    expect(appKitConfig.attachments.yjsArrayName).toBe('attachments')
    expect(appKitConfig.attachments.endpoint).toBe('/api/attachments')
    expect(appKitConfig.attachments.webStorageProvider).toBe('web-object-storage')
    expect(appKitConfig.sync.roomParam).toBe('room')
    expect(appKitConfig.server.recordsPath).toBe('/api/records')
    expect(appKitConfig.chat.stream.mode).toBe('mock')
    expect(appKitConfig.chat.stream.transport).toBe('sse')
    expect(appKitConfig.chat.stream.endpoint).toBe('/api/agent/chat/stream')
    expect(appKitConfig.chat.stream.toolResultPath).toBe('/api/agent/tool-results')
  })

  it('keeps the Cloudflare worker as a required frontend-side component', () => {
    expect(appKitConfig.frontendWorker.enabled).toBe(true)
    expect(appKitConfig.frontendWorker.role).toBe('frontend-edge-companion')
    expect(appKitConfig.frontendWorker.websocketPath).toBe(appKitConfig.sync.websocketPath)
    expect(appKitConfig.frontendWorker.healthPath).toBe('/api/health')
  })

  it('resolves deployment defaults for local, cloud, and on-premise installs', () => {
    expect(resolveDeploymentMode(undefined)).toBe('local')
    expect(resolveDeploymentMode('cloud')).toBe('cloud')
    expect(resolveDeploymentMode('onprem')).toBe('onprem')
    expect(resolveDeploymentMode('invalid')).toBe('local')

    expect(resolveSyncBackend('local', undefined)).toBe('rust-server')
    expect(resolveSyncBackend('cloud', undefined)).toBe('cloudflare-durable-object')
    expect(resolveSyncBackend('onprem', undefined)).toBe('rust-server')
    expect(resolveSyncBackend('onprem', 'cloudflare-durable-object')).toBe(
      'cloudflare-durable-object'
    )

    expect(resolveFrontendWorkerRuntime('cloud', undefined)).toBe('cloudflare-workers')
    expect(resolveFrontendWorkerRuntime('onprem', undefined)).toBe('workerd')
    expect(resolveFrontendWorkerRuntime('onprem', 'cloudflare-workers')).toBe(
      'cloudflare-workers'
    )

    expect(resolveAppServerBackend(undefined)).toBe('rust-server')
    expect(resolveAppServerBackend('external-api')).toBe('external-api')

    expect(resolveChatStreamMode('local', undefined)).toBe('mock')
    expect(resolveChatStreamMode('cloud', undefined)).toBe('backend')
    expect(resolveChatStreamMode('onprem', 'mock')).toBe('mock')
    expect(resolveChatStreamTransport(undefined)).toBe('sse')
    expect(resolveChatStreamTransport('websocket')).toBe('websocket')
  })

  it('builds storage keys from the app namespace', () => {
    expect(namespacedKey('another-app', 'theme')).toBe('another-app-theme')
    expect(appKitConfig.storage.themeKey).toBe(
      namespacedKey(appKitConfig.app.storageNamespace, 'theme')
    )
  })

  it('configures record defaults without hardcoding them in UI components', () => {
    expect(appKitConfig.records.identifierPrefix).toMatch(/^[A-Z]+$/)
    expect(appKitConfig.records.defaultProject).toBeTruthy()
  })

  it('defines a configurable business workflow for records', () => {
    const workflow = appKitConfig.workflows.definitions.find(
      (definition) => definition.id === appKitConfig.workflows.defaultWorkflowId
    )

    expect(workflow?.name).toBe('Default Record Workflow')
    expect(workflow?.stages.map((stage) => stage.id)).toEqual([
      'intake',
      'ready',
      'execution',
      'validation',
      'completed',
      'cancelled',
    ])
    expect(workflow?.transitions.some((transition) => transition.kind === 'exception')).toBe(true)
  })
})

describe('buildRoomId', () => {
  it('encodes the record room as workspace:<id>:records per ADR-0001', () => {
    expect(buildRoomId('photon-default', 'records')).toBe('workspace:photon-default:records')
  })

  it('supports composite surfaces such as docs and chat threads', () => {
    expect(buildRoomId('acme', 'doc:42')).toBe('workspace:acme:doc:42')
    expect(buildRoomId('acme', 'chat:general')).toBe('workspace:acme:chat:general')
  })

  it('builds room-scoped websocket paths', () => {
    expect(buildSyncWebsocketPath('workspace:acme:doc:42')).toBe('/ws?room=workspace:acme:doc:42')
  })
})
