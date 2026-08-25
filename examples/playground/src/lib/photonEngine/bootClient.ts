import type { LiveQuery, PhotonClient, QueryState } from '@quantum-box/photon-core'

const loadingList: QueryState<never[]> = {
  data: [],
  status: 'loading',
  error: null,
  pending: false,
}

const loadingRecord: QueryState<null> = {
  data: null,
  status: 'loading',
  error: null,
  pending: false,
}

// One frozen snapshot per shape: useSyncExternalStore treats a fresh object
// per getSnapshot call as an endless stream of updates.
function constantQuery<R>(snapshot: QueryState<R>): LiveQuery<R> {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    destroy: () => {},
  }
}

/**
 * A client whose every query reports `loading` forever.
 *
 * The real engine takes seconds to boot — PGlite plus the WASM kernel, and
 * far longer when two tabs cold-start against the same IndexedDB — and the
 * first paint must not wait for that. This stands in behind the same
 * <PhotonProvider> until the real client resolves, so the swap changes
 * context value, not tree shape, and unmounts nothing.
 *
 * Storybook uses it too: stories render deterministically against an engine
 * that never loads.
 */
export function createBootingPhotonClient(): PhotonClient {
  return {
    query: () => constantQuery(loadingList),
    liveRecord: () => constantQuery(loadingRecord),
    hydrateCollection: () => Promise.resolve(),
  } as unknown as PhotonClient
}
