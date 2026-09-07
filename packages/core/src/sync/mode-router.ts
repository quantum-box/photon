/**
 * Routing between collection modes.
 *
 * One client can hold engine-native collections (pushed to a server that
 * speaks the engine protocol) and rest-backed collections (pushed through the
 * application's own REST API) at the same time. This transport is what makes
 * that a per-collection config choice instead of a per-client one: the sync
 * loop keeps talking to a single `SyncTransport`, and the split happens here.
 *
 * Passthrough collections never push through this router — the client pushes
 * them inline at mutation time because they have no offline queue — but their
 * reads are served by the same REST transport, so they participate in `pull`.
 */

import type { Collection, Operation } from '../types.js'
import type { PullRequest, PushRequest, PushResult, SyncTransport } from './types.js'

export type RoutedCollectionMode = 'engine-native' | 'rest-backed' | 'passthrough'

export interface ModeRouterOptions {
  /** Transport for a server speaking the engine protocol, when there is one. */
  readonly engine?: SyncTransport
  /** Transport wrapping the app's REST resources (rest-backed + passthrough). */
  readonly rest?: SyncTransport
  readonly modeOf: (collection: Collection) => RoutedCollectionMode
}

/**
 * Returns a transport that fans out by collection mode, or the single
 * underlying transport when no routing is needed.
 */
export function createModeRouterTransport(options: ModeRouterOptions): SyncTransport | undefined {
  const { engine, rest, modeOf } = options
  if (!rest) return engine
  if (!engine) {
    return {
      ...(rest.pullSelection ? { pullSelection: (request: import('../selection.js').SelectionPullRequest) => rest.pullSelection!(request) } : {}),
      push: (request) => rest.push(filterOperations(request, (op) => modeOf(op.key.collection) === 'rest-backed')),
      pull: (request) => rest.pull(request),
    }
  }

  return {
    supportsAtomic: engine.supportsAtomic === true,
    async pullSelection(request) {
      const target = modeOf(request.selector.collection) === 'engine-native' ? engine : rest
      if (!target.pullSelection) throw new Error('transport does not support partial sync')
      return target.pullSelection(request)
    },
    async push(request: PushRequest): Promise<PushResult> {
      if (request.atomicBatchId) {
        if (!engine.supportsAtomic || request.operations.some(op => modeOf(op.key.collection) !== 'engine-native')) {
          throw new Error('atomic batches cannot span transports')
        }
        return engine.push(request)
      }
      const engineOperations: Operation[] = []
      const restOperations: Operation[] = []
      for (const operation of request.operations) {
        switch (modeOf(operation.key.collection)) {
          case 'rest-backed':
            restOperations.push(operation)
            break
          case 'engine-native':
            engineOperations.push(operation)
            break
          case 'passthrough':
            // Pushed inline at mutation time; nothing queued ever routes here.
            break
        }
      }

      const [engineResult, restResult] = await Promise.all([
        engineOperations.length
          ? engine.push({ ...request, operations: engineOperations })
          : Promise.resolve<PushResult>({ decisions: [] }),
        restOperations.length
          ? rest.push({ ...request, operations: restOperations })
          : Promise.resolve<PushResult>({ decisions: [] }),
      ])

      return { decisions: [...engineResult.decisions, ...restResult.decisions] }
    },

    async pull(request: PullRequest) {
      // The engine log drains first: it is the latency-sensitive path and its
      // pages chain on a cursor. Once it reports nothing new, the same cycle
      // refreshes one REST collection instead of returning empty-handed, so
      // rest-backed data is already live on the very first sync.
      const page = await engine.pull(request)
      if (page.kind !== 'operations' || page.operations.length > 0) return page
      return rest.pull(request)
    },
  }
}

function filterOperations(request: PushRequest, keep: (operation: Operation) => boolean): PushRequest {
  return { ...request, operations: request.operations.filter(keep) }
}
