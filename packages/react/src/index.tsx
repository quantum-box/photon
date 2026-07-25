/**
 * React bindings for the Photon engine.
 *
 * Everything here sits on `useSyncExternalStore` over the engine's live
 * queries. The hooks return plain data and callbacks and nothing else — no
 * toasts, no spinners, no modals. A UI library like native-ui takes props; the
 * engine supplies state. Neither should own the other's job.
 */

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import type {
  AckResult,
  ChangeSet,
  Collection,
  Conflict,
  MutationHandle,
  PhotonClient,
  PhotonRecord,
  QueryDescriptor,
  QueryState,
  RecordId,
  SyncStatus,
} from '@quantum-box/photon-core'

export interface PhotonMutationError extends Error {
  readonly operationId: string
  readonly result: AckResult
}

export interface MutationErrorContext {
  /** Re-run the same mutation function with the same arguments. */
  retry(): void
}

export interface PhotonProviderProps {
  readonly client: PhotonClient
  /**
   * Where failed writes surface. The engine has already rolled the record back
   * by the time this fires; presenting that is the application's call.
   */
  readonly onMutationError?: (error: PhotonMutationError, context: MutationErrorContext) => void
  readonly children: ReactNode
}

interface ContextValue {
  readonly client: PhotonClient
  readonly onMutationError?: PhotonProviderProps['onMutationError']
}

const PhotonContext = createContext<ContextValue | null>(null)

export function PhotonProvider({ client, onMutationError, children }: PhotonProviderProps) {
  const value = useMemo<ContextValue>(
    () => (onMutationError ? { client, onMutationError } : { client }),
    [client, onMutationError],
  )
  return <PhotonContext.Provider value={value}>{children}</PhotonContext.Provider>
}

export function usePhotonClient(): PhotonClient {
  const context = useContext(PhotonContext)
  if (!context) throw new Error('usePhotonClient must be used inside a <PhotonProvider>')
  return context.client
}

/**
 * Subscribe to a live query.
 *
 * `getSnapshot` returns a cached value whose identity does not change until
 * listeners are notified — the engine guarantees it, and useSyncExternalStore
 * requires it. Violating that guarantee is the classic infinite-render bug.
 */
export function useLiveQuery<T = unknown>(
  descriptor: QueryDescriptor<T>,
  deps?: readonly unknown[],
): QueryState<PhotonRecord<T>[]> {
  const client = usePhotonClient()

  // A serializable descriptor is its own dependency key. A function predicate
  // changes identity every render, which is why `deps` is mandatory for it.
  const key = useMemo(
    () => (deps ? JSON.stringify(deps) : stableKey(descriptor)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps ?? [stableKey(descriptor)],
  )

  const query = useMemo(
    () => client.query<T>(descriptor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, key],
  )

  useEffect(() => () => query.destroy(), [query])

  return useSyncExternalStore(
    useCallback((listener) => query.subscribe(listener), [query]),
    useCallback(() => query.getSnapshot(), [query]),
    useCallback(() => query.getSnapshot(), [query]),
  )
}

export function useRecord<T = unknown>(
  collection: Collection,
  recordId: RecordId,
): QueryState<PhotonRecord<T> | null> {
  const client = usePhotonClient()
  const query = useMemo(
    () => client.liveRecord<T>(collection, recordId),
    [client, collection, recordId],
  )
  useEffect(() => () => query.destroy(), [query])

  return useSyncExternalStore(
    useCallback((listener) => query.subscribe(listener), [query]),
    useCallback(() => query.getSnapshot(), [query]),
    useCallback(() => query.getSnapshot(), [query]),
  )
}

export interface UseMutationOptions<TResult> {
  readonly onSettled?: (result: AckResult, handle: MutationHandle<TResult>) => void
}

export interface UseMutationResult<TArgs, TResult> {
  /**
   * Returns the handle synchronously, so a caller can read the optimistic
   * record — the freshly created id to navigate to, for instance — without
   * awaiting anything.
   */
  mutate(args: TArgs): MutationHandle<TResult>
  readonly isPending: boolean
  readonly error: PhotonMutationError | null
  reset(): void
}

export function useMutation<TArgs = void, TResult = unknown>(
  fn: (client: PhotonClient, args: TArgs) => MutationHandle<TResult>,
  options?: UseMutationOptions<TResult>,
): UseMutationResult<TArgs, TResult> {
  const context = useContext(PhotonContext)
  if (!context) throw new Error('useMutation must be used inside a <PhotonProvider>')
  const { client, onMutationError } = context

  const [inFlight, setInFlight] = useState(0)
  const [error, setError] = useState<PhotonMutationError | null>(null)

  // Written in an effect, not during render: React may render a component more
  // than once before committing, and a ref written on a discarded render is a
  // torn value.
  const fnRef = useRef(fn)
  const optionsRef = useRef(options)
  useEffect(() => {
    fnRef.current = fn
    optionsRef.current = options
  })

  // `retry` has to call the same mutate this hook returns, so it reads it back
  // through a ref rather than closing over a not-yet-initialized binding.
  const mutateRef = useRef<(args: TArgs) => MutationHandle<TResult>>(null)

  const mutate = useCallback(
    (args: TArgs): MutationHandle<TResult> => {
      const handle = fnRef.current(client, args)
      setInFlight((n) => n + 1)
      setError(null)

      void handle.settled.then((result) => {
        // The optimistic value is already applied; only the acknowledgement
        // needs to be a transition.
        startTransition(() => setInFlight((n) => Math.max(0, n - 1)))
        optionsRef.current?.onSettled?.(result, handle)

        if (result.status === 'accepted') return

        const failure = Object.assign(
          new Error(
            result.status === 'rejected'
              ? result.reason
              : 'This change conflicts with another edit',
          ),
          { operationId: result.operationId, result },
        ) as PhotonMutationError
        setError(failure)
        onMutationError?.(failure, { retry: () => void mutateRef.current?.(args) })
      })

      return handle
    },
    [client, onMutationError],
  )

  useEffect(() => {
    mutateRef.current = mutate
  }, [mutate])

  return {
    mutate,
    isPending: inFlight > 0,
    error,
    reset: useCallback(() => setError(null), []),
  }
}

export function useSyncStatus(): SyncStatus {
  const client = usePhotonClient()
  return useSyncExternalStore(
    useCallback((listener) => client.sync.subscribe(listener), [client]),
    useCallback(() => client.sync.getStatus(), [client]),
    useCallback(() => client.sync.getStatus(), [client]),
  )
}

export function useOnline(): boolean {
  return useSyncStatus().online
}

export function usePendingCount(): number {
  return useSyncStatus().pendingOperations
}

export function useConflicts(collection?: Collection): readonly Conflict[] {
  const client = usePhotonClient()
  return useSyncExternalStore(
    useCallback((listener) => client.subscribeChanges(listener), [client]),
    useCallback(() => client.conflicts(collection), [client, collection]),
    useCallback(() => client.conflicts(collection), [client, collection]),
  )
}

/**
 * UI-only optimism, for state that *should* vanish on refresh.
 *
 * Durable optimism belongs in the store: `client.patch()` is already visible
 * before paint and survives unmount. Use this only for a drag ghost, an
 * uncommitted inline edit buffer, and similar throwaway state.
 */
export function useOptimisticRecord<T>(
  record: PhotonRecord<T> | null,
): [T | null, (patch: Partial<T>) => void] {
  const stamp = record ? `${record.version.wall_time_ms}:${record.version.counter}` : null
  const [state, setState] = useState<{ stamp: string | null; overlay: Partial<T> | null }>({
    stamp,
    overlay: null,
  })

  // Derived during render rather than reset in an effect: an effect would paint
  // one frame of stale overlay over an already-updated record.
  const overlay = state.stamp === stamp ? state.overlay : null

  const value = useMemo(() => {
    if (!record) return null
    return overlay ? { ...record.value, ...overlay } : record.value
  }, [record, overlay])

  const apply = useCallback(
    (patch: Partial<T>) =>
      setState((previous) => ({
        stamp,
        overlay: { ...(previous.stamp === stamp ? previous.overlay : null), ...patch },
      })),
    [stamp],
  )

  return [value, apply]
}

export function useChangeSubscription(listener: (changes: ChangeSet) => void): void {
  const client = usePhotonClient()
  const ref = useRef(listener)
  useEffect(() => {
    ref.current = listener
  })
  useEffect(() => client.subscribeChanges((changes) => ref.current(changes)), [client])
}

/** State for a sync debug panel. The rendering is the application's. */
export interface PhotonEngineDebug {
  readonly status: SyncStatus
  readonly stats: {
    operations: Record<string, number>
    recordsByCollection: Record<string, number>
  } | null
  refresh(): void
  syncNow(): void
}

export function usePhotonEngineDebug(): PhotonEngineDebug {
  const client = usePhotonClient()
  const status = useSyncStatus()
  const [stats, setStats] = useState<PhotonEngineDebug['stats']>(null)

  const refresh = useCallback(() => {
    void client.storage.stats(client.scope).then(setStats)
  }, [client])

  useEffect(refresh, [refresh, status.lastSyncAt])

  return {
    status,
    stats,
    refresh,
    syncNow: useCallback(() => void client.sync.syncNow('manual'), [client]),
  }
}

function stableKey(descriptor: QueryDescriptor<never>): string {
  return JSON.stringify([
    descriptor.collection,
    descriptor.where ?? null,
    descriptor.orderBy ?? null,
    descriptor.limit ?? null,
    descriptor.offset ?? null,
    descriptor.includeDeleted ?? false,
  ])
}
