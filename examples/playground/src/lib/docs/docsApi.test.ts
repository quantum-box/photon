import { describe, expect, it } from 'vitest'
import { appKitConfig } from '../../app/kitConfig'
import { toDocMetadata, type ServerDocumentMetadata } from './docsApi'

describe('docsApi', () => {
  it('normalizes engine-backed server document metadata for the local docs cache', () => {
    const serverDocument: ServerDocumentMetadata = {
      id: 'doc-1',
      title: 'Offline sync spec',
      workspace_id: 'photon-default',
      created_at: '2026-05-15T00:00:00Z',
      updated_at: '2026-05-15T00:10:00Z',
    }

    expect(toDocMetadata(serverDocument)).toEqual({
      id: 'doc-1',
      title: 'Offline sync spec',
      workspaceId: 'photon-default',
      createdAt: '2026-05-15T00:00:00Z',
      updatedAt: '2026-05-15T00:10:00Z',
    })
  })

  it('keeps sparse server projections renderable during rollout', () => {
    expect(
      toDocMetadata({
        id: 'doc-legacy',
        title: '',
        workspace_id: '',
        created_at: '2026-05-15T00:00:00Z',
        updated_at: '2026-05-15T00:00:00Z',
      })
    ).toMatchObject({
      id: 'doc-legacy',
      title: appKitConfig.docs.defaultTitle,
      workspaceId: appKitConfig.workspace.id,
    })
  })
})
