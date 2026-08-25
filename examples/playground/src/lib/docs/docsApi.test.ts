import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appKitConfig } from '../../app/kitConfig'

const engineMocks = vi.hoisted(() => ({
  getRecord: vi.fn(),
  listRecords: vi.fn(),
  patchRecord: vi.fn(),
  sync: vi.fn(),
  upsertRecord: vi.fn(),
}))

vi.mock('../photonEngine/client', () => ({
  getClientEngineRecord: engineMocks.getRecord,
  listClientEngineRecords: engineMocks.listRecords,
  patchClientEngineRecord: engineMocks.patchRecord,
  syncClientEngineOperations: engineMocks.sync,
  upsertClientEngineRecord: engineMocks.upsertRecord,
}))

import {
  fetchServerDocument,
  fetchServerDocuments,
  toDocMetadata,
  type ServerDocumentMetadata,
} from './docsApi'

describe('docsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    engineMocks.sync.mockResolvedValue({ pushed: 0, pulled: 0 })
  })

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

  it('syncs before reading the document list from a fresh local store', async () => {
    engineMocks.listRecords.mockResolvedValue([])

    await expect(fetchServerDocuments()).resolves.toEqual([])

    expect(engineMocks.sync).toHaveBeenCalledOnce()
    expect(engineMocks.sync.mock.invocationCallOrder[0])
      .toBeLessThan(engineMocks.listRecords.mock.invocationCallOrder[0])
  })

  it('syncs before deciding that direct-link metadata is missing', async () => {
    engineMocks.getRecord.mockResolvedValue(null)

    await expect(fetchServerDocument('shared-doc')).rejects.toMatchObject({
      name: 'DocsApiError',
      status: 404,
    })

    expect(engineMocks.sync).toHaveBeenCalledOnce()
    expect(engineMocks.sync.mock.invocationCallOrder[0])
      .toBeLessThan(engineMocks.getRecord.mock.invocationCallOrder[0])
  })
})
