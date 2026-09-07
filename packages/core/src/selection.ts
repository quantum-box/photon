import type { EngineRecord, Operation, Scope } from './types.js'

export type Scalar = string | number | boolean | null
export type SelectionFilter =
  | { readonly field: string; readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; readonly value: Scalar }
  | { readonly field: string; readonly op: 'in'; readonly value: readonly Scalar[] }
  | { readonly field: string; readonly op: 'exists'; readonly value: boolean }

/** Serializable interest, not an authorization grant. All filters are ANDed. */
export interface RecordSelection {
  readonly collection: string
  readonly recordIds?: readonly string[]
  readonly filters?: readonly SelectionFilter[]
}

export interface RecordPageRequest extends RecordSelection {
  readonly includeDeleted?: boolean
  readonly afterId?: string
  readonly limit: number
}

export interface RecordPage {
  readonly records: readonly EngineRecord[]
  readonly nextAfterId: string | null
  readonly hasMore: boolean
}

export interface SelectionCursor {
  readonly scope: Scope
  readonly selector: RecordSelection
  readonly phase: 'snapshot' | 'delta'
  readonly position: number
  readonly afterId: string | null
}

export interface SelectionPullRequest {
  readonly scope: Scope
  readonly selector: RecordSelection
  readonly cursor: SelectionCursor | null
  readonly limit: number
  /** A bounded page of IDs already held by this subscription, for revocation checks. */
  readonly knownRecordIds?: readonly string[]
  readonly pendingOperations?: readonly Operation[]
  readonly signal?: AbortSignal
}

export type RemovalReason = 'deleted' | 'out_of_scope' | 'revoked'
export interface SelectionRemoval {
  readonly recordId: string
  readonly reason: RemovalReason
}
export interface RecordCheckpoint {
  readonly record: EngineRecord
  readonly sequence: number
}
export interface OperationReceipt {
  readonly operationId: string
  readonly remoteSequence: number
}
export interface SelectionPullResult {
  readonly records: readonly RecordCheckpoint[]
  readonly receipts?: readonly OperationReceipt[]
  readonly removals: readonly SelectionRemoval[]
  readonly cursor: SelectionCursor
  readonly hasMore: boolean
}

export interface SelectionState {
  readonly scope: Scope
  readonly id: string
  readonly selector: RecordSelection
  readonly cursor: SelectionCursor | null
  /** Partial data must never masquerade as an empty, complete result. */
  readonly status: 'uninitialized' | 'partial' | 'complete'
  readonly updatedAtMs: number | null
  readonly validationAfterId?: string | null
}

export interface SyncSubscription {
  getSnapshot(): SelectionState & { readonly error: Error | null }
  subscribe(listener: () => void): () => void
  /** Fetch bounded pages; more calls continue when the page budget is exhausted. */
  refresh(): Promise<void>
  /** Stop refreshing. The durable cache remains available offline. */
  close(): void
  /** Forget this interest and evict its unshared cache; pending edits survive. */
  release(): Promise<void>
}

export function validateSelection(selection: RecordSelection): void {
  if (!selection.collection || selection.collection.length > 256) throw new Error('invalid collection')
  if ((selection.recordIds?.length ?? 0) > 1000) throw new Error('at most 1000 record IDs are supported')
  if (selection.recordIds?.some(id => !id || id.length > 512)) throw new Error('invalid record ID')
  if ((selection.filters?.length ?? 0) > 32) throw new Error('at most 32 filters are supported')
  for (const filter of selection.filters ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(filter.field) || filter.field.length > 256) {
      throw new Error('invalid filter field path')
    }
    const scalar = (value: unknown): boolean => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length > 1000 || !filter.value.every(scalar)) throw new Error('invalid in filter')
    } else if (filter.op === 'exists') {
      if (typeof filter.value !== 'boolean') throw new Error('invalid exists filter')
    } else if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(filter.op) || !scalar(filter.value)) {
      throw new Error('invalid comparison filter')
    } else if (['gt', 'gte', 'lt', 'lte'].includes(filter.op) && typeof filter.value !== 'number' && typeof filter.value !== 'string') {
      throw new Error('range filters require a number or string')
    }
  }
}

/** Canonical copy prevents callers mutating an active cursor's meaning. */
export function normalizeSelection(selection: RecordSelection): RecordSelection {
  validateSelection(selection)
  return {
    collection: selection.collection,
    ...(selection.recordIds ? { recordIds: [...new Set(selection.recordIds)].sort() } : {}),
    ...(selection.filters ? { filters: selection.filters.map(f => ({ field: f.field, op: f.op, value: Array.isArray(f.value) ? [...f.value] : f.value } as SelectionFilter)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
  }
}

export function sameSelection(a: RecordSelection, b: RecordSelection): boolean {
  return JSON.stringify(normalizeSelection(a)) === JSON.stringify(normalizeSelection(b))
}
