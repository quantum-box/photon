export interface FileAttachment {
  id: string
  name: string
  size: number
  type: string
  url: string // object URL
  file: File
}

export type FileType = 'pdf' | 'excel' | 'csv' | 'docx' | 'pptx' | 'unknown'

export function detectFileType(file: File): FileType {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mime = file.type

  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (ext === 'xlsx' || ext === 'xls' || mime.includes('spreadsheet') || mime.includes('excel'))
    return 'excel'
  if (ext === 'csv' || mime === 'text/csv') return 'csv'
  if (ext === 'docx' || mime.includes('wordprocessingml')) return 'docx'
  if (ext === 'pptx' || mime.includes('presentationml')) return 'pptx'
  return 'unknown'
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FILE_ICONS: Record<FileType, string> = {
  pdf: '📄',
  excel: '📊',
  csv: '📊',
  docx: '📝',
  pptx: '📑',
  unknown: '📎',
}

const FILE_COLORS: Record<FileType, string> = {
  pdf: '#e74c3c',
  excel: '#27ae60',
  csv: '#27ae60',
  docx: '#2980b9',
  pptx: '#e67e22',
  unknown: '#8a8a9a',
}

export function getFileIcon(type: FileType): string {
  return FILE_ICONS[type]
}

export function getFileColor(type: FileType): string {
  return FILE_COLORS[type]
}
