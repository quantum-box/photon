import { type FileAttachment, detectAttachmentFileType } from './types'
import { PdfViewer } from './PdfViewer'
import { SpreadsheetViewer } from './SpreadsheetViewer'
import { DocxViewer } from './DocxViewer'
import { PptxViewer } from './PptxViewer'

interface FilePreviewModalProps {
  file: FileAttachment
  onClose: () => void
}

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const fileType = detectAttachmentFileType(file)
  const canPreviewLocalFile = Boolean(file.file)
  const downloadUrl = file.url

  const renderViewer = () => {
    if (!canPreviewLocalFile && fileType !== 'pdf') {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <p className="text-sm text-subtle">
            Preview metadata is synced. Open this file from the device that uploaded it or download it when object storage is configured.
          </p>
        </div>
      )
    }

    switch (fileType) {
      case 'pdf':
        return file.url ? <PdfViewer url={file.url} name={file.name} /> : (
          <div className="flex h-full items-center justify-center text-sm text-subtle">
            PDF content is not cached on this device.
          </div>
        )
      case 'excel':
      case 'csv':
        return file.file ? <SpreadsheetViewer file={file.file} name={file.name} /> : null
      case 'docx':
        return file.file ? <DocxViewer file={file.file} name={file.name} /> : null
      case 'pptx':
        return file.file ? <PptxViewer file={file.file} name={file.name} /> : null
      default:
        return (
          <div className="flex items-center justify-center h-full">
            <p className="text-subtle">Preview not available for this file type</p>
          </div>
        )
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onClick={onClose}
    >
      <div
        className="flex h-[100dvh] w-screen flex-col overflow-hidden border-border bg-canvas sm:h-[85vh] sm:w-[85vw] sm:max-w-[1100px] sm:rounded-xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border bg-panel px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm">
              {fileType === 'pdf' ? '📄' : fileType === 'excel' || fileType === 'csv' ? '📊' : fileType === 'docx' ? '📝' : fileType === 'pptx' ? '📑' : '📎'}
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              {file.name}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {downloadUrl && (
              <a
                href={downloadUrl}
                download={file.name}
                className="px-3 py-1 rounded text-xs cursor-pointer bg-surface-hover text-muted"
              >
                Download
              </a>
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 rounded flex items-center justify-center text-sm cursor-pointer transition-colors text-subtle hover:bg-surface-hover hover:text-foreground"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Viewer */}
        <div className="flex-1 min-h-0">
          {renderViewer()}
        </div>
      </div>
    </div>
  )
}
