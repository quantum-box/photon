/**
 * Transport for a server that speaks the Photon Engine protocol.
 *
 * All HTTP lives here, never in the engine itself. Auth arrives through a
 * `headers` hook rather than a bundled auth client: the engine should never
 * know which identity provider an application uses.
 */

import type { Operation } from '../types.js'
import { SyncProtocolError } from './types.js'
import type {
  PullRequest,
  PullResult,
  PushDecision,
  PushRequest,
  PushResult,
  SyncTransport,
} from './types.js'

export interface EngineTransportOptions {
  readonly baseUrl: string
  readonly pushPath?: string
  readonly pullPath?: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>
  /** Every request is bounded. Without this a stalled socket wedges the loop. */
  readonly timeoutMs?: number
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SyncHttpError'
  }
}

interface WirePullResponse {
  operations?: { operation: Operation; remote_sequence: number }[]
  cursor?: number | null
  has_more?: boolean
}

export function createEngineTransport(options: EngineTransportOptions): SyncTransport {
  // Resolved per request, not captured at construction: a host may install or
  // replace a fetch wrapper after the client is built, and capturing the
  // binding here would silently ignore it.
  const doFetch = (): typeof globalThis.fetch => {
    const impl = options.fetch ?? globalThis.fetch
    if (!impl) throw new Error('createEngineTransport requires a fetch implementation')
    return impl
  }

  const base = options.baseUrl.replace(/\/+$/, '')
  const pushPath = options.pushPath ?? '/api/engine/push'
  const pullPath = options.pullPath ?? '/api/engine/pull'
  const timeoutMs = options.timeoutMs ?? 15_000

  async function post<TResponse>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<TResponse> {
    const headers = {
      'content-type': 'application/json',
      ...((await options.headers?.()) ?? {}),
    }

    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? anySignal([signal, timeout]) : timeout

    const response = await doFetch()(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    })

    if (!response.ok) {
      throw new SyncHttpError(response.status, `${path} responded ${response.status}`)
    }
    return (await response.json()) as TResponse
  }

  return {
    async push(request: PushRequest): Promise<PushResult> {
      const body = await post<unknown>(
        pushPath,
        { scope: request.scope, operations: request.operations },
        request.signal,
      )

      return { decisions: parsePushDecisions(body) }
    },

    async pull(request: PullRequest): Promise<PullResult> {
      const body = await post<WirePullResponse>(
        pullPath,
        {
          scope: request.scope,
          // The wire cursor is an object; the engine tracks the position.
          cursor:
            request.cursor === null
              ? null
              : { scope: request.scope, remote: 'photon-server', position: request.cursor, updated_at_ms: 0 },
          limit: request.limit,
        },
        request.signal,
      )

      const operations = (body.operations ?? []).map((row) => ({
        operation: row.operation,
        remoteSequence: row.remote_sequence,
      }))

      return {
        kind: 'operations',
        operations,
        cursor:
          body.cursor ??
          (operations.length ? operations[operations.length - 1]!.remoteSequence : request.cursor),
        hasMore: body.has_more ?? operations.length >= request.limit,
      }
    },
  }
}

function parsePushDecisions(body: unknown): PushDecision[] {
  if (!isObject(body) || !Array.isArray(body.decisions)) {
    throw new SyncProtocolError('Engine push response must contain a decisions array')
  }
  return body.decisions.map((raw, index) => parsePushDecision(raw, index))
}

function parsePushDecision(raw: unknown, index: number): PushDecision {
  if (!isObject(raw)) {
    throw new SyncProtocolError(`Engine push decision ${index} must be an object`)
  }

  const operationId = requiredString(raw.operation_id, `decision ${index} operation_id`)
  const providedDiscriminants = [raw.type, raw.decision, raw.kind].filter(
    (value) => value !== undefined,
  )
  if (
    providedDiscriminants.some(
      (value) => typeof value !== 'string' || value.length === 0,
    )
  ) {
    throw new SyncProtocolError(`Engine push decision ${operationId} has an invalid decision kind`)
  }
  const discriminants = providedDiscriminants as string[]
  if (!discriminants.length || new Set(discriminants).size !== 1) {
    throw new SyncProtocolError(`Engine push decision ${operationId} has no single decision kind`)
  }

  switch (discriminants[0]) {
    case 'accepted':
      return {
        kind: 'accepted',
        operationId,
        remoteSequence: requiredSafeInteger(raw.remote_sequence, 'remote_sequence'),
        ...optionalString(raw.alias_record_id, 'alias_record_id'),
      }
    case 'rejected':
      return {
        kind: 'rejected',
        operationId,
        reason: requiredString(raw.reason, `rejected decision ${operationId} reason`),
      }
    case 'conflict': {
      const conflict = isObject(raw.conflict) ? raw.conflict : raw
      return {
        kind: 'conflict',
        operationId,
        reason: requiredString(conflict.reason, `conflict decision ${operationId} reason`),
        ...(conflict.remote_value === undefined ? {} : { remoteValue: conflict.remote_value }),
      }
    }
    default:
      throw new SyncProtocolError(
        `Engine push decision ${operationId} has unsupported kind ${discriminants[0]}`,
      )
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length) {
    throw new SyncProtocolError(`Engine push response ${field} must be a non-empty string`)
  }
  return value
}

function optionalString(
  value: unknown,
  field: string,
): { aliasRecordId?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string' || !value.length) {
    throw new SyncProtocolError(`Engine push response ${field} must be a non-empty string`)
  }
  return { aliasRecordId: value }
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SyncProtocolError(`Engine push response ${field} must be a non-negative safe integer`)
  }
  return value as number
}

/** `AbortSignal.any` is not available everywhere yet. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const withAny = AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }
  if (typeof withAny.any === 'function') return withAny.any(signals)

  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}
