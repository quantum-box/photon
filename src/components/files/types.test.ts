import { describe, expect, it } from 'vitest'
import { detectFileType, formatFileSize, getFileColor, getFileIcon } from './types'

function file(name: string, type = '') {
  return new File(['content'], name, { type })
}

describe('file type helpers', () => {
  it('detects supported file types by extension and MIME type', () => {
    expect(detectFileType(file('brief.pdf'))).toBe('pdf')
    expect(detectFileType(file('metrics.xlsx'))).toBe('excel')
    expect(detectFileType(file('metrics', 'application/vnd.ms-excel'))).toBe('excel')
    expect(detectFileType(file('items.csv'))).toBe('csv')
    expect(detectFileType(file('proposal.docx'))).toBe('docx')
    expect(detectFileType(file('deck.pptx'))).toBe('pptx')
    expect(detectFileType(file('archive.zip'))).toBe('unknown')
  })

  it('formats file sizes for compact UI labels', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  it('provides display metadata for every known file type', () => {
    for (const type of ['pdf', 'excel', 'csv', 'docx', 'pptx', 'unknown'] as const) {
      expect(getFileIcon(type)).toBeTruthy()
      expect(getFileColor(type)).toMatch(/^#/)
    }
  })
})
