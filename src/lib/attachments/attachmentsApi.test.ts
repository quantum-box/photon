import { describe, expect, it } from 'vitest'
import { toWorkspaceAttachment } from './attachmentsApi'

describe('attachment metadata API mapping', () => {
  it('keeps content metadata separate from preview metadata and links', () => {
    const attachment = toWorkspaceAttachment({
      id: 'att-1',
      workspace_id: 'photon-default',
      filename: 'brief.pdf',
      content_type: 'application/pdf',
      byte_size: 1234,
      storage_provider: 'web-object-storage',
      storage_key: 'photon-default/attachments/att-1',
      content_status: 'local_cache',
      preview_metadata: {
        fileType: 'pdf',
        previewStatus: 'available',
        previewGeneratedAt: '2026-05-14T00:00:00.000Z',
      },
      created_by: null,
      created_at: '2026-05-14T00:00:00.000Z',
      updated_at: '2026-05-14T00:00:00.000Z',
      links: [
        {
          id: 'link-1',
          attachment_id: 'att-1',
          surface_type: 'issue',
          surface_id: 'issue-1',
          created_at: '2026-05-14T00:00:00.000Z',
        },
        {
          id: 'link-2',
          attachment_id: 'att-1',
          surface_type: 'document',
          surface_id: 'doc-1',
          created_at: '2026-05-14T00:00:00.000Z',
        },
      ],
    })

    expect(attachment).toMatchObject({
      id: 'att-1',
      filename: 'brief.pdf',
      contentStatus: 'local_cache',
      previewMetadata: { fileType: 'pdf', previewStatus: 'available' },
    })
    expect(attachment.links.map((link) => `${link.surfaceType}:${link.surfaceId}`)).toEqual([
      'issue:issue-1',
      'document:doc-1',
    ])
  })
})
