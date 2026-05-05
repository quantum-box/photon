import { describe, expect, it } from 'vitest'
import { appKitConfig } from './kitConfig'

describe('appKitConfig', () => {
  it('defines the project-specific extension points for the client app kit', () => {
    expect(appKitConfig.workspace.name).toBe('Photon')
    expect(appKitConfig.workspace.initial).toHaveLength(1)
    expect(appKitConfig.workspace.primaryNav.length).toBeGreaterThan(0)
    expect(appKitConfig.workspace.projects.length).toBeGreaterThan(0)
    expect(appKitConfig.workspace.users.length).toBeGreaterThan(0)
  })

  it('keeps runtime storage and sync keys explicit', () => {
    expect(appKitConfig.storage.themeKey).toBe('photon-theme')
    expect(appKitConfig.sync.persistenceKey).toBe('photon-issues')
    expect(appKitConfig.sync.yjsArrayName).toBe('issues')
    expect(appKitConfig.sync.websocketPath).toBe('/ws')
  })

  it('configures issue defaults without hardcoding them in UI components', () => {
    expect(appKitConfig.issues.identifierPrefix).toMatch(/^[A-Z]+$/)
    expect(appKitConfig.issues.defaultProject).toBeTruthy()
  })
})
