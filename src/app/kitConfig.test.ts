import { describe, expect, it } from 'vitest'
import { appKitConfig, buildRoomId, buildSyncWebsocketPath } from './kitConfig'

describe('appKitConfig', () => {
  it('defines the project-specific extension points for the client app kit', () => {
    expect(appKitConfig.workspace.name).toBe('Photon')
    expect(appKitConfig.workspace.initial).toHaveLength(1)
    expect(appKitConfig.workspace.id).toBe('photon-default')
    expect(appKitConfig.workspace.primaryNav.length).toBeGreaterThan(0)
    expect(appKitConfig.workspace.projects.length).toBeGreaterThan(0)
    expect(appKitConfig.workspace.users.length).toBeGreaterThan(0)
  })

  it('keeps runtime storage and sync keys explicit', () => {
    expect(appKitConfig.storage.themeKey).toBe('photon-theme')
    expect(appKitConfig.sync.workspaceId).toBe('photon-default')
    expect(appKitConfig.sync.issuesRoomId).toBe('workspace:photon-default:issues')
    expect(appKitConfig.sync.persistenceKey).toBe('workspace:photon-default:issues')
    expect(appKitConfig.sync.yjsArrayName).toBe('issues')
    expect(appKitConfig.sync.websocketPath).toBe('/ws?room=workspace:photon-default:issues')
    expect(appKitConfig.docs.pgliteDataDir).toBe('idb://photon-docs')
    expect(appKitConfig.docs.yjsArrayName).toBe('blocks')
    expect(appKitConfig.server.issuesPath).toBe('/api/issues')
  })

  it('configures issue defaults without hardcoding them in UI components', () => {
    expect(appKitConfig.issues.identifierPrefix).toMatch(/^[A-Z]+$/)
    expect(appKitConfig.issues.defaultProject).toBeTruthy()
  })
})

describe('buildRoomId', () => {
  it('encodes the issue room as workspace:<id>:issues per ADR-0001', () => {
    expect(buildRoomId('photon-default', 'issues')).toBe('workspace:photon-default:issues')
  })

  it('supports composite surfaces such as docs and chat threads', () => {
    expect(buildRoomId('acme', 'doc:42')).toBe('workspace:acme:doc:42')
    expect(buildRoomId('acme', 'chat:general')).toBe('workspace:acme:chat:general')
  })

  it('builds room-scoped websocket paths', () => {
    expect(buildSyncWebsocketPath('workspace:acme:doc:42')).toBe('/ws?room=workspace:acme:doc:42')
  })
})
