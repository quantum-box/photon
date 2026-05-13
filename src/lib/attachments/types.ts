import type { FileType } from '../../components/files/types'

export type AttachmentSurfaceType = 'issue' | 'chat' | 'document'
export type AttachmentStorageProvider = 'web-object-storage' | 'tauri-local-file-cache'
export type AttachmentContentStatus = 'local_cache' | 'uploaded' | 'remote_missing' | 'deleted'

export interface AttachmentLink {
  id: string
  attachmentId: string
  surfaceType: AttachmentSurfaceType
  surfaceId: string
  createdAt: string
}

export interface AttachmentPreviewMetadata {
  fileType: FileType
  previewStatus: 'available' | 'metadata_only' | 'unsupported'
  previewGeneratedAt?: string
}

export interface WorkspaceAttachment {
  id: string
  workspaceId: string
  filename: string
  contentType: string
  byteSize: number
  storageProvider: AttachmentStorageProvider
  storageKey: string
  contentStatus: AttachmentContentStatus
  previewMetadata: AttachmentPreviewMetadata
  createdBy: string | null
  createdAt: string
  updatedAt: string
  links: AttachmentLink[]
  objectUrl?: string
  file?: File
}

export interface AttachmentSurfaceRef {
  surfaceType: AttachmentSurfaceType
  surfaceId: string
}

export interface CreateWorkspaceAttachmentInput {
  file: File
  links: AttachmentSurfaceRef[]
}
