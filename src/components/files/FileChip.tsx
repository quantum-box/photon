import { type FileAttachment, detectFileType, formatFileSize, getFileIcon, getFileColor } from './types'

interface FileChipProps {
  file: FileAttachment
  onPreview: (file: FileAttachment) => void
  onRemove?: (fileId: string) => void
}

export function FileChip({ file, onPreview, onRemove }: FileChipProps) {
  const fileType = detectFileType(file.file)
  const icon = getFileIcon(fileType)
  const color = getFileColor(fileType)
  const ext = file.name.split('.').pop()?.toUpperCase() ?? ''

  return (
    <div
      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors group/chip bg-surface border border-border hover:bg-surface-hover"
      onClick={() => onPreview(file)}
    >
      <div
        className="w-8 h-8 rounded flex items-center justify-center text-sm flex-shrink-0"
        style={{ background: `${color}20`, color }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium truncate text-foreground" style={{ maxWidth: 160 }}>
          {file.name}
        </p>
        <p className="text-xs text-subtle">
          {ext} · {formatFileSize(file.size)}
        </p>
      </div>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(file.id) }}
          className="w-5 h-5 rounded flex items-center justify-center text-xs opacity-0 group-hover/chip:opacity-100 transition-opacity cursor-pointer text-subtle hover:text-foreground"
        >
          ✕
        </button>
      )}
    </div>
  )
}
