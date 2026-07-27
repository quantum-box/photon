import type { DocumentRecordLink } from './types'

const CURRENT_DOC_KEY = 'photon:docs:current-document'
const SELECTED_TEXT_KEY = 'photon:docs:selected-text'

export interface WorkspaceDocContext {
  docId: string
  title: string
  url: string
  selectedText: string
  relatedRecords: DocumentRecordLink[]
}

interface StoredDocContext {
  docId: string
  title: string
  url: string
}

export function setCurrentDocContext(docId: string, title: string, url: string) {
  try {
    window.localStorage.setItem(CURRENT_DOC_KEY, JSON.stringify({ docId, title, url }))
  } catch {
    // LocalStorage can be unavailable in restricted browser modes.
  }
}

export function setCurrentDocSelectedText(docId: string, text: string) {
  try {
    window.localStorage.setItem(SELECTED_TEXT_KEY, JSON.stringify({ docId, text }))
  } catch {
    // LocalStorage can be unavailable in restricted browser modes.
  }
}

export function readStoredDocContext(): StoredDocContext | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_DOC_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDocContext>
    if (!parsed.docId || !parsed.title || !parsed.url) return null
    return { docId: parsed.docId, title: parsed.title, url: parsed.url }
  } catch {
    return null
  }
}

export function readStoredSelectedText(docId: string): string {
  try {
    const raw = window.localStorage.getItem(SELECTED_TEXT_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { docId?: string; text?: string }
    return parsed.docId === docId && parsed.text ? parsed.text : ''
  } catch {
    return ''
  }
}
