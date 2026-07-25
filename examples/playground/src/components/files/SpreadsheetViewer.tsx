import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'

interface SpreadsheetViewerProps {
  file: File
  name: string
}

interface SheetData {
  name: string
  headers: string[]
  rows: string[][]
}

export function SpreadsheetViewer({ file, name }: SpreadsheetViewerProps) {
  const [sheets, setSheets] = useState<SheetData[]>([])
  const [activeSheet, setActiveSheet] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const reader = new FileReader()
    reader.onload = (e) => {
      if (cancelled) return
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })

        const parsed: SheetData[] = workbook.SheetNames.map((sheetName) => {
          const sheet = workbook.Sheets[sheetName]
          const json = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
          const headers = (json[0] ?? []).map(String)
          const rows = json.slice(1).map((row) => row.map(String))
          return { name: sheetName, headers, rows }
        })

        setSheets(parsed)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse file')
      }
    }

    if (file.name.endsWith('.csv') || file.type === 'text/csv') {
      reader.readAsText(file)
      reader.onload = (e) => {
        if (cancelled) return
        try {
          const text = e.target!.result as string
          const workbook = XLSX.read(text, { type: 'string' })
          const sheet = workbook.Sheets[workbook.SheetNames[0]]
          const json = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
          const headers = (json[0] ?? []).map(String)
          const rows = json.slice(1).map((row) => row.map(String))
          setSheets([{ name: 'Sheet1', headers, rows }])
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to parse CSV')
        }
      }
    } else {
      reader.readAsArrayBuffer(file)
    }

    return () => { cancelled = true }
  }, [file])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-priority-urgent">
        <p>Failed to load spreadsheet: {error}</p>
      </div>
    )
  }

  if (sheets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 rounded-full animate-bounce-dot bg-accent" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    )
  }

  const sheet = sheets[activeSheet]

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0 bg-surface">
        <span className="text-xs font-medium truncate mr-2 text-muted">
          {name}
        </span>
        <span className="text-xs text-subtle">
          {sheet.rows.length} rows
        </span>
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex border-b border-border px-2 gap-1 flex-shrink-0 bg-surface">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                i === activeSheet
                  ? 'text-foreground border-b-2 border-accent'
                  : 'text-subtle border-b-2 border-transparent'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th
                className="sticky top-0 px-3 py-2 text-left font-medium border-b border-r border-border bg-surface text-subtle"
                style={{ width: 40 }}
              >
                #
              </th>
              {sheet.headers.map((h, i) => (
                <th
                  key={i}
                  className="sticky top-0 px-3 py-2 text-left font-medium border-b border-r border-border bg-surface text-foreground whitespace-nowrap"
                  style={{ minWidth: 100 }}
                >
                  {h || `Col ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr
                key={ri}
                className="hover:bg-surface-hover transition-colors"
              >
                <td className="px-3 py-1.5 border-b border-r border-border text-subtle">
                  {ri + 1}
                </td>
                {sheet.headers.map((_, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 border-b border-r border-border text-foreground whitespace-nowrap"
                  >
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
