/**
 * Scope and key conventions.
 *
 * A scope is opaque to the engine — it only ever compares them for equality.
 * These helpers exist so callers stop reinventing the string format and
 * accidentally splitting one workspace across two scopes.
 *
 * Pure functions only: nothing here reads `window`, `localStorage`, or
 * `import.meta.env`.
 */

export interface WorkspaceScopeInput {
  tenantId: string
  workspaceId: string
}

const SEGMENT = /[^a-zA-Z0-9._-]+/g

function slug(value: string): string {
  const normalized = value.trim().replace(SEGMENT, '-').replace(/^-+|-+$/g, '')
  if (!normalized) {
    throw new Error(`Scope segment is empty after normalization: ${JSON.stringify(value)}`)
  }
  return normalized
}

/** `workspace:<tenant>:<workspace>` — the scope every collection is stored under. */
export function buildWorkspaceScope({ tenantId, workspaceId }: WorkspaceScopeInput): string {
  return `workspace:${slug(tenantId)}:${slug(workspaceId)}`
}

/** The Live room id for a scope's realtime channel. */
export function buildRoomId(scope: string, channel: string): string {
  return `${scope}:${slug(channel)}`
}

/** A storage key namespaced by scope, so two workspaces never share a database. */
export function namespacedKey(scope: string, name: string): string {
  return `${scope}:${slug(name)}`
}

/** Stable string form of a record key, for use as a Map index. */
export function recordKeyIndex(scope: string, collection: string, recordId: string): string {
  // Unit separator: cannot appear in an id, so this cannot collide the way a
  // ':' or '/' separator can.
  return `${scope}${collection}${recordId}`
}
