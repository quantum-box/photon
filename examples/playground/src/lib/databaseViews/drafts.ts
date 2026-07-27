import type { DatabaseViewDefinition } from './types'

const DRAFT_PREFIX = 'photon-database-view-draft'
const OWNER_KEY = 'photon-database-view-draft-owner'

interface StoredDraft {
  ownerId: string
  view: DatabaseViewDefinition
}

function getStorageKey(view: Pick<DatabaseViewDefinition, 'databaseId' | 'id'>) {
  return `${DRAFT_PREFIX}:${view.databaseId}:${view.id}`
}

function getDraftOwnerId() {
  if (typeof window === 'undefined') return 'server'
  const existing = window.sessionStorage?.getItem(OWNER_KEY)
  if (existing) return existing

  const ownerId =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  window.sessionStorage?.setItem(OWNER_KEY, ownerId)
  return ownerId
}

export function loadDatabaseViewDraft(
  view: Pick<DatabaseViewDefinition, 'databaseId' | 'id'>
): DatabaseViewDefinition | null {
  if (typeof window === 'undefined') return null

  try {
    const stored = window.localStorage.getItem(getStorageKey(view))
    if (!stored) return null
    const parsed = JSON.parse(stored) as Partial<StoredDraft>
    if (parsed.ownerId !== getDraftOwnerId()) return null
    return parsed.view ?? null
  } catch {
    return null
  }
}

export function saveDatabaseViewDraft(view: DatabaseViewDefinition) {
  if (typeof window === 'undefined') return
  const draft: StoredDraft = { ownerId: getDraftOwnerId(), view }
  window.localStorage.setItem(getStorageKey(view), JSON.stringify(draft))
}

export function clearDatabaseViewDraft(view: Pick<DatabaseViewDefinition, 'databaseId' | 'id'>) {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(getStorageKey(view))
}
