import type { SelectionPullRequest, SelectionPullResult } from '../selection.js'
/**
 * Running the engine against a plain REST API.
 *
 * This is what makes adoption staged rather than all-or-nothing. An application
 * keeps its existing HTTP client, its interceptors, its auth, and its
 * endpoints, and still gets an offline write queue, optimistic UI, automatic
 * rollback and conflict rows. Component code is identical to the engine-native
 * case, so a collection can be upgraded later by changing one config line.
 *
 * What it cannot give you is CRDT merge. That is a property of the protocol,
 * not of this adapter: `increment`, `setAdd`, `setRemove` and `removeFields`
 * have no REST representation, so they are resolved against the local
 * projection and sent as a plain patch. Concurrent edits therefore resolve
 * last-write-wins at the REST boundary. Collections that need real merge
 * belong on `engine-native`.
 */

import type { Collection, Operation, OperationKind, RecordId } from '../types.js'
import type {
  PullRequest,
  PullResult,
  PushDecision,
  PushRequest,
  PushResult,
  RemoteRecord,
  SyncTransport,
} from '../sync/types.js'

export interface RestListResult<T> {
  readonly items: readonly T[]
  /**
   * True only when `items` is the *entire* collection.
   *
   * This is what makes "deleted upstream" distinguishable from "not on this
   * page". Default to false and set it deliberately: claiming completeness for
   * a paginated response deletes local records that still exist.
   */
  readonly complete?: boolean
}

/**
 * The application's own HTTP calls, wrapped.
 *
 * Nothing here takes a client, a base URL, or headers: the closure already has
 * whatever the app uses. The engine deliberately does not want to know.
 */
export interface RestOperationContext {
  readonly operationId: string
  readonly scope: string
  readonly actorId: string
  readonly expectedVersion?: string | number
  readonly signal?: AbortSignal
}

export interface RestResource<T> {
  /** Optional host change-feed adapter; never inferred from a paginated list. */
  pullSelection?(request: SelectionPullRequest): Promise<SelectionPullResult>
  list(): Promise<RestListResult<T> | readonly T[]>
  create(value: T, context: RestOperationContext): Promise<T | void>
  /**
   * Create-or-replace, when the backend has PUT-style semantics. Preferred for
   * `upsert` operations, because the client cannot tell a first write from an
   * edit: the optimistic value is in the projection either way.
   */
  upsert?(recordId: RecordId, value: T, context: RestOperationContext): Promise<T | void>
  update(recordId: RecordId, fields: Partial<T>, context: RestOperationContext): Promise<T | void>
  remove(recordId: RecordId, context: RestOperationContext): Promise<void>
  /** Map one item to its record id and stored value. */
  toRecord(item: T): { recordId: RecordId; value: unknown; deleted?: boolean }
}

export interface RestTransportOptions {
  readonly resources: Readonly<Record<Collection, RestResource<never>>>
  /**
   * Local projection, used to resolve CRDT-only operations into a patch.
   *
   * It is not evidence that the server has the record: the client writes the
   * optimistic value in before the push runs, so a first write and an edit look
   * identical here. That is why `upsert` operations prefer
   * `RestResource.upsert`, and why a resource without one relies on the backend
   * tolerating an update to an id it has never seen.
   */
  readonly readRecord?: (collection: Collection, recordId: RecordId) => unknown
}

/**
 * Anything with a numeric `status`: fetch `Response`, axios error, or a
 * hand-rolled error class. Adapters only need to preserve that one field.
 */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: number; response?: { status?: number } } | null)?.status
  if (typeof status === 'number') return status
  const nested = (error as { response?: { status?: number } } | null)?.response?.status
  return typeof nested === 'number' ? nested : undefined
}

/**
 * Map an HTTP outcome onto an engine decision.
 *
 * This mapping is the adapter's real value. Once a backend's answer is
 * expressed as a decision, rollback-by-replay, conflict rows, and
 * `useMutation.error` all behave identically whether or not the server speaks
 * the engine protocol.
 *
 * 401/403 and 5xx are deliberately *not* decisions: they are transport
 * failures. Turning them into rejections would roll back a write that the user
 * will be able to make as soon as they sign in again, or as soon as the server
 * recovers.
 */
export function decisionForError(operationId: string, error: unknown): PushDecision | null {
  const status = statusOf(error)
  if (status === undefined) return null

  if (status === 400 || status === 422) {
    return { kind: 'rejected', operationId, reason: messageOf(error) }
  }
  if (status === 409 || status === 412 || status === 428) {
    return { kind: 'conflict', operationId, reason: messageOf(error) }
  }
  if (status === 404) {
    // The record is gone upstream. Rejecting drops the local write and lets the
    // next pull reconcile, which is better than retrying forever.
    return { kind: 'rejected', operationId, reason: 'record no longer exists on the server' }
  }
  return null
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'the server rejected this change'
}

/**
 * Reduce an operation to something REST can express.
 *
 * CRDT-only kinds are computed against the current local value and sent as a
 * patch. This is where merge semantics are lost, and it is unavoidable: a plain
 * REST endpoint has no way to represent "add 1 to whatever the server has".
 */
function toRestChange(
  operation: Operation,
  current: unknown,
): { type: 'create' | 'update' | 'delete'; fields: Record<string, unknown> } {
  const base = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>
  const kind: OperationKind = operation.kind

  switch (kind.type) {
    case 'upsert':
      // A guess, and only reached when the resource has no `upsert`: `current`
      // is the local projection, which already holds the optimistic value, so a
      // first write reads as an edit. See `RestTransportOptions.readRecord`.
      return { type: current ? 'update' : 'create', fields: kind.value as Record<string, unknown> }
    case 'restore':
      return {
        type: 'create',
        fields: (kind.value ?? base) as Record<string, unknown>,
      }
    case 'patch':
      return { type: 'update', fields: kind.fields }
    case 'delete':
      return { type: 'delete', fields: {} }
    case 'remove_fields':
      return {
        type: 'update',
        fields: Object.fromEntries(kind.fields.map((field) => [field, null])),
      }
    case 'increment': {
      const previous = typeof base[kind.field] === 'number' ? (base[kind.field] as number) : 0
      return { type: 'update', fields: { [kind.field]: previous + kind.by } }
    }
    case 'set_add': {
      const previous = Array.isArray(base[kind.field]) ? (base[kind.field] as unknown[]) : []
      return { type: 'update', fields: { [kind.field]: [...new Set([...previous, ...kind.values])] } }
    }
    case 'set_remove': {
      const previous = Array.isArray(base[kind.field]) ? (base[kind.field] as unknown[]) : []
      return {
        type: 'update',
        fields: { [kind.field]: previous.filter((value) => !kind.values.includes(value)) },
      }
    }
  }
}

/**
 * A REST backend usually assigns its own id. When it differs, the engine swaps
 * the local record for the server one in a single transaction — the temp-id
 * dance that `newId()` removes for engine-native collections but cannot remove
 * here.
 */
function acceptance(
  operationId: string,
  recordId: RecordId,
  resource: RestResource<never>,
  returned: unknown,
): PushDecision {
  const assigned =
    returned === undefined || returned === null
      ? recordId
      : resource.toRecord(returned as never).recordId
  return assigned === recordId
    ? { kind: 'accepted', operationId }
    : { kind: 'accepted', operationId, aliasRecordId: assigned }
}

function normalizeList<T>(result: RestListResult<T> | readonly T[]): RestListResult<T> {
  return Array.isArray(result) ? { items: result, complete: false } : (result as RestListResult<T>)
}

export function createRestTransport(options: RestTransportOptions): SyncTransport {
  const readRecord = options.readRecord ?? (() => undefined)
  // Round-robins collections so one large collection cannot starve the others.
  let pullCursor = 0

  return {
    async pullSelection(request) {
      const resource = options.resources[request.selector.collection]
      if (!resource?.pullSelection) throw new Error('REST resource does not implement partial sync')
      return resource.pullSelection(request)
    },
    async push(request: PushRequest): Promise<PushResult> {
      if (request.atomicBatchId) throw new Error('REST transport does not support atomic batches')
      // Group by record: REST has no notion of operation order, so a create
      // must land before the patch that follows it. Different records are
      // independent and run concurrently.
      const byRecord = new Map<string, Operation[]>()
      for (const operation of request.operations) {
        const key = `${operation.key.collection}${operation.key.record_id}`
        const bucket = byRecord.get(key)
        if (bucket) bucket.push(operation)
        else byRecord.set(key, [operation])
      }

      const results = await Promise.all(
        [...byRecord.values()].map((operations) => pushRecord(operations, request.signal)),
      )
      return { decisions: results.flat() }
    },

    async pull(request: PullRequest): Promise<PullResult> {
      const collections = request.collections?.length
        ? [...request.collections]
        : Object.keys(options.resources)

      if (!collections.length) {
        return { kind: 'operations', operations: [], cursor: request.cursor }
      }

      const collection = collections[pullCursor % collections.length]!
      pullCursor += 1

      const resource = options.resources[collection]
      if (!resource) {
        return { kind: 'operations', operations: [], cursor: request.cursor }
      }

      const listed = normalizeList(await resource.list())
      const records: RemoteRecord[] = listed.items.map((item) => {
        const mapped = resource.toRecord(item as never)
        return {
          collection,
          recordId: mapped.recordId,
          value: mapped.value,
          ...(mapped.deleted === undefined ? {} : { deleted: mapped.deleted }),
        }
      })

      return {
        kind: 'snapshot',
        collection,
        records,
        complete: listed.complete ?? false,
        cursor: request.cursor,
      }
    },
  }

  async function pushRecord(operations: readonly Operation[], signal?: AbortSignal): Promise<PushDecision[]> {
    const decisions: PushDecision[] = []

    for (const operation of operations) {
      const { collection, record_id: recordId } = operation.key
      const resource = options.resources[collection]

      if (!resource) {
        decisions.push({
          kind: 'rejected',
          operationId: operation.id,
          reason: `no REST resource is configured for collection "${collection}"`,
        })
        continue
      }

      const version = (operation.metadata as { photon_context?: { expectedVersion?: string | number } } | undefined)?.photon_context?.expectedVersion
      const context: RestOperationContext = Object.freeze({
        operationId: operation.id, scope: operation.key.scope, actorId: operation.actor_id,
        ...(version === undefined ? {} : { expectedVersion: version }),
        ...(signal ? { signal } : {}),
      })
      const kind = operation.kind

      try {
        if (kind.type === 'upsert' && resource.upsert) {
          // The one operation the create/update split cannot get right on its
          // own, so hand the whole question to the backend when it can answer
          // it. Without this, a first write goes out as an update against an id
          // the server has never seen: a 404, which `decisionForError` maps to
          // `rejected`, silently dropping the record the user just made.
          const saved: unknown = await resource.upsert(recordId, kind.value as never, context)
          decisions.push(acceptance(operation.id, recordId, resource, saved))
          continue
        }

        const change = toRestChange(operation, readRecord(collection, recordId))

        if (change.type === 'delete') {
          await resource.remove(recordId, context)
          decisions.push({ kind: 'accepted', operationId: operation.id })
          continue
        }

        if (change.type === 'create') {
          const created: unknown = await resource.create(change.fields as never, context)
          decisions.push(acceptance(operation.id, recordId, resource, created))
          continue
        }

        await resource.update(recordId, change.fields as never, context)
        decisions.push({ kind: 'accepted', operationId: operation.id })
      } catch (error) {
        const decision = decisionForError(operation.id, error)
        // No decision means it was a transport failure, not a verdict. Rethrow
        // so the sync loop treats it as retryable rather than rolling the
        // user's write back.
        if (!decision) throw error
        decisions.push(decision)

        // Later operations on this record assumed this one landed, so stop.
        const rest = operations.slice(operations.indexOf(operation) + 1)
        for (const skipped of rest) {
          decisions.push({
            kind: 'rejected',
            operationId: skipped.id,
            reason: 'a preceding change to this record failed',
          })
        }
        break
      }
    }

    return decisions
  }
}
