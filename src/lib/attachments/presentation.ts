import type { FileAttachment } from '../../components/files/types'
import type { WorkspaceAttachment } from './types'

export function toFileAttachment(attachment: WorkspaceAttachment): FileAttachment {
  return {
    id: attachment.id,
    name: attachment.filename,
    size: attachment.byteSize,
    type: attachment.contentType,
    url: attachment.objectUrl,
    file: attachment.file,
    previewType: attachment.previewMetadata.fileType,
  }
}
