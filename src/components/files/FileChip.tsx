import { type FileAttachment, detectAttachmentFileType, formatFileSize, getFileIcon, getFileColor } from './types'

interface FileChipProps {
  file: FileAttachment
  onPreview: (file: FileAttachment) => void
  onRemove?: (fileId: string) => void
}

export function FileChip({ file, onPreview, onRemove }: FileChipProps) {
  const fileType = detectAttachmentFileType(file)
  const icon = getFileIcon(fileType)
  const color = getFileColor(fileType)
  const ext = file.name.split('.').pop()?.toUpperCase() ?? ''

  return (
    <div
      className="group/chip inline-flex max-w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-2 py-2 transition-colors hover:bg-surface-hover sm:px-3"
      onClick={() => onPreview(file)}
    >
      <div
        className="w-8 h-8 rounded flex items-center justify-center text-sm flex-shrink-0"
        style={{ background: `${color}20`, color }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="max-w-[11rem] truncate text-xs font-medium text-foreground">
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
