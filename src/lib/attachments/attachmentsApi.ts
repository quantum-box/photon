import { appKitConfig } from '../../app/kitConfig'
import { detectFileType } from '../../components/files/types'
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

interface ServerAttachmentListResponse {
  attachments: ServerAttachment[]
  total: number
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

function buildApiUrl(path: string) {
  const baseUrl = appKitConfig.server.apiBaseUrl?.replace(/\/$/, '') ?? ''
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new AttachmentApiError(message || response.statusText, response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

function normalizeSurfaceType(value: string): AttachmentSurfaceType {
  return value === 'issue' || value === 'chat' || value === 'document' ? value : 'chat'
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

function surfaceQuery(surface?: AttachmentSurfaceRef) {
  const params = new URLSearchParams({ workspace_id: appKitConfig.workspace.id })
  if (surface) {
    params.set('surface_type', surface.surfaceType)
    params.set('surface_id', surface.surfaceId)
  }
  return params.toString()
}

export async function fetchServerAttachments(surface?: AttachmentSurfaceRef): Promise<WorkspaceAttachment[]> {
  const response = await request<ServerAttachmentListResponse>(
    `${appKitConfig.attachments.endpoint}?${surfaceQuery(surface)}`
  )
  return response.attachments.map(toWorkspaceAttachment)
}

export async function createServerAttachment(
  input: CreateAttachmentMetadataInput
): Promise<WorkspaceAttachment> {
  const fileType = detectFileType(input.file)
  const attachment = await request<ServerAttachment>(appKitConfig.attachments.endpoint, {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: appKitConfig.workspace.id,
      filename: input.file.name,
      content_type: input.file.type || 'application/octet-stream',
      byte_size: input.file.size,
      storage_provider: appKitConfig.attachments.webStorageProvider,
      content_status: 'local_cache',
      preview_metadata: {
        fileType,
        previewStatus: fileType === 'unknown' ? 'unsupported' : 'available',
        previewGeneratedAt: new Date().toISOString(),
      },
      links: input.links.map((link) => ({
        surface_type: link.surfaceType,
        surface_id: link.surfaceId,
      })),
    }),
  })
  return toWorkspaceAttachment(attachment)
}

export async function linkServerAttachment(
  attachmentId: string,
  surface: AttachmentSurfaceRef
): Promise<WorkspaceAttachment> {
  const attachment = await request<ServerAttachment>(
    `${appKitConfig.attachments.endpoint}/${encodeURIComponent(attachmentId)}/links`,
    {
      method: 'POST',
      body: JSON.stringify({
        surface_type: surface.surfaceType,
        surface_id: surface.surfaceId,
      }),
    }
  )
  return toWorkspaceAttachment(attachment)
}

export async function deleteServerAttachment(attachmentId: string): Promise<void> {
  await request<void>(`${appKitConfig.attachments.endpoint}/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
  })
}
