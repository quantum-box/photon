/**
 * Transport for a server that speaks the Photon Engine protocol.
 *
 * All HTTP lives here, never in the engine itself. Auth arrives through a
 * `headers` hook rather than a bundled auth client: the engine should never
 * know which identity provider an application uses.
 */

import type { Operation } from '../types.js'
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

interface WirePushResponse {
  decisions?: {
    operation_id: string
    decision?: string
    kind?: string
    reason?: string
    remote_sequence?: number
    alias_record_id?: string
    remote_value?: unknown
  }[]
}

interface WirePullResponse {
  operations?: { operation: Operation; remote_sequence: number }[]
  cursor?: number | null
  has_more?: boolean
}

function normalizeDecisionKind(raw: string | undefined): PushDecision['kind'] {
  switch (raw) {
    case 'rejected':
      return 'rejected'
    case 'conflict':
      return 'conflict'
    default:
      return 'accepted'
  }
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
      const body = await post<WirePushResponse>(
        pushPath,
        { scope: request.scope, operations: request.operations },
        request.signal,
      )

      const decisions: PushDecision[] = (body.decisions ?? []).map((raw) => {
        const operationId = raw.operation_id
        switch (normalizeDecisionKind(raw.decision ?? raw.kind)) {
          case 'rejected':
            return { kind: 'rejected', operationId, reason: raw.reason ?? 'rejected by server' }
          case 'conflict':
            return {
              kind: 'conflict',
              operationId,
              reason: raw.reason ?? 'conflicting concurrent write',
              ...(raw.remote_value === undefined ? {} : { remoteValue: raw.remote_value }),
            }
          default:
            return {
              kind: 'accepted',
              operationId,
              ...(raw.remote_sequence === undefined ? {} : { remoteSequence: raw.remote_sequence }),
              ...(raw.alias_record_id === undefined ? {} : { aliasRecordId: raw.alias_record_id }),
            }
        }
      })

      return { decisions }
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
