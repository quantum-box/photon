import { appKitConfig } from '../../app/kitConfig'
import { detectFileType } from '../../components/files/types'
import {
  deleteClientEngineRecord,
  getClientEngineRecord,
  listClientEngineRecords,
  patchClientEngineRecord,
  upsertClientEngineRecord,
} from '../photonEngine/client'
import type {
  AttachmentContentStatus,
  AttachmentLink,
  AttachmentPreviewMetadata,
  AttachmentStorageProvider,
  AttachmentSurfaceRef,
  AttachmentSurfaceType,
  WorkspaceAttachment,
} from './types'

interface ServerAttachmentLink {
  id: string
  attachment_id: string
  surface_type: string
  surface_id: string
  created_at: string
}

interface ServerAttachment {
  id: string
  workspace_id: string
  filename: string
  content_type: string
  byte_size: number
  storage_provider: string
  storage_key: string
  content_status: string
  preview_metadata?: Partial<AttachmentPreviewMetadata> | null
  created_by?: string | null
  created_at: string
  updated_at: string
  links?: ServerAttachmentLink[]
}

export interface CreateAttachmentMetadataInput {
  file: File
  links: AttachmentSurfaceRef[]
}

export class AttachmentApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AttachmentApiError'
    this.status = status
  }
}

function normalizeSurfaceType(value: string): AttachmentSurfaceType {
  if (value === 'record' || value === 'chat' || value === 'document') {
    return value
  }
  return 'chat'
}

function normalizeStorageProvider(value: string): AttachmentStorageProvider {
  return value === 'tauri-local-file-cache'
    ? 'tauri-local-file-cache'
    : appKitConfig.attachments.webStorageProvider
}

function normalizeContentStatus(value: string): AttachmentContentStatus {
  if (value === 'uploaded' || value === 'remote_missing' || value === 'deleted') return value
  return 'local_cache'
}

function normalizePreviewMetadata(
  metadata: Partial<AttachmentPreviewMetadata> | null | undefined,
  filename: string,
  contentType: string
): AttachmentPreviewMetadata {
  const file = new File([], filename, { type: contentType })
  const fileType = metadata?.fileType ?? detectFileType(file)
  return {
    fileType,
    previewStatus: metadata?.previewStatus ?? (fileType === 'unknown' ? 'unsupported' : 'metadata_only'),
    previewGeneratedAt: metadata?.previewGeneratedAt,
  }
}

export function toWorkspaceAttachment(serverAttachment: ServerAttachment): WorkspaceAttachment {
  return {
    id: serverAttachment.id,
    workspaceId: serverAttachment.workspace_id,
    filename: serverAttachment.filename,
    contentType: serverAttachment.content_type,
    byteSize: serverAttachment.byte_size,
    storageProvider: normalizeStorageProvider(serverAttachment.storage_provider),
    storageKey: serverAttachment.storage_key,
    contentStatus: normalizeContentStatus(serverAttachment.content_status),
    previewMetadata: normalizePreviewMetadata(
      serverAttachment.preview_metadata,
      serverAttachment.filename,
      serverAttachment.content_type
    ),
    createdBy: serverAttachment.created_by ?? null,
    createdAt: serverAttachment.created_at,
    updatedAt: serverAttachment.updated_at,
    links: (serverAttachment.links ?? []).map(toAttachmentLink),
  }
}

function toAttachmentLink(serverLink: ServerAttachmentLink): AttachmentLink {
  return {
    id: serverLink.id,
    attachmentId: serverLink.attachment_id,
    surfaceType: normalizeSurfaceType(serverLink.surface_type),
    surfaceId: serverLink.surface_id,
    createdAt: serverLink.created_at,
  }
}

export async function fetchServerAttachments(surface?: AttachmentSurfaceRef): Promise<WorkspaceAttachment[]> {
  const records = await listClientEngineRecords<WorkspaceAttachment>('attachments')
  return records
    .map((record) => record.value)
    .filter((attachment) => attachment.workspaceId === appKitConfig.workspace.id)
    .filter((attachment) => {
      if (!surface) return true
      return attachment.links.some((link) =>
        link.surfaceType === surface.surfaceType && link.surfaceId === surface.surfaceId
      )
    })
}

export async function createServerAttachment(
  input: CreateAttachmentMetadataInput
): Promise<WorkspaceAttachment> {
  const fileType = detectFileType(input.file)
  const id = globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}`
  const now = new Date().toISOString()
  const attachment: WorkspaceAttachment = {
    id,
    workspaceId: appKitConfig.workspace.id,
    filename: input.file.name,
    contentType: input.file.type || 'application/octet-stream',
    byteSize: input.file.size,
    storageProvider: appKitConfig.attachments.webStorageProvider,
    storageKey: `${appKitConfig.workspace.id}/attachments/${id}`,
    contentStatus: 'local_cache',
    previewMetadata: {
      fileType,
      previewStatus: fileType === 'unknown' ? 'unsupported' : 'available',
      previewGeneratedAt: now,
    },
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    links: input.links.map((link) => ({
      id: globalThis.crypto?.randomUUID?.() ?? `attachment-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      attachmentId: id,
      surfaceType: link.surfaceType,
      surfaceId: link.surfaceId,
      createdAt: now,
    })),
  }
  const record = await upsertClientEngineRecord('attachments', attachment.id, attachment)
  return record.value
}

export async function linkServerAttachment(
  attachmentId: string,
  surface: AttachmentSurfaceRef
): Promise<WorkspaceAttachment> {
  const record = await getClientEngineRecord<WorkspaceAttachment>('attachments', attachmentId)
  if (!record) throw new AttachmentApiError('Attachment not found', 404)
  const now = new Date().toISOString()
  const existingLink = record.value.links.find((link) =>
    link.surfaceType === surface.surfaceType && link.surfaceId === surface.surfaceId
  )
  const attachment: WorkspaceAttachment = {
    ...record.value,
    updatedAt: now,
    links: existingLink
      ? record.value.links
      : [
          ...record.value.links,
          {
            id: globalThis.crypto?.randomUUID?.() ?? `attachment-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            attachmentId,
            surfaceType: surface.surfaceType,
            surfaceId: surface.surfaceId,
            createdAt: now,
          },
        ],
  }
  const nextRecord = await patchClientEngineRecord<WorkspaceAttachment>(
    'attachments',
    attachmentId,
    attachment
  )
  if (!nextRecord) throw new AttachmentApiError('Attachment not found', 404)
  return nextRecord.value
}

export async function deleteServerAttachment(attachmentId: string): Promise<void> {
  await deleteClientEngineRecord('attachments', attachmentId)
}
