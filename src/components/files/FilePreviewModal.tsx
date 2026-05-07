import { type FileAttachment, detectFileType } from './types'
import { PdfViewer } from './PdfViewer'
import { SpreadsheetViewer } from './SpreadsheetViewer'
import { DocxViewer } from './DocxViewer'
import { PptxViewer } from './PptxViewer'

interface FilePreviewModalProps {
  file: FileAttachment
  onClose: () => void
}

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const fileType = detectFileType(file.file)

  const renderViewer = () => {
    switch (fileType) {
      case 'pdf':
        return <PdfViewer url={file.url} name={file.name} />
      case 'excel':
      case 'csv':
        return <SpreadsheetViewer file={file.file} name={file.name} />
      case 'docx':
        return <DocxViewer file={file.file} name={file.name} />
      case 'pptx':
        return <PptxViewer file={file.file} name={file.name} />
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
            <a
              href={file.url}
              download={file.name}
              className="px-3 py-1 rounded text-xs cursor-pointer bg-surface-hover text-muted"
            >
              Download
            </a>
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
