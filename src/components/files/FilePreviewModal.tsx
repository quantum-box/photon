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
            <p style={{ color: 'var(--text-muted)' }}>Preview not available for this file type</p>
          </div>
        )
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl overflow-hidden flex flex-col"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          width: '85vw',
          height: '85vh',
          maxWidth: 1100,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b flex-shrink-0"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-sidebar)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">
              {fileType === 'pdf' ? '📄' : fileType === 'excel' || fileType === 'csv' ? '📊' : fileType === 'docx' ? '📝' : fileType === 'pptx' ? '📑' : '📎'}
            </span>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {file.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={file.url}
              download={file.name}
              className="px-3 py-1 rounded text-xs cursor-pointer"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
            >
              Download
            </a>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded flex items-center justify-center text-sm cursor-pointer transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
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
