import type {
  LiveQuery,
  PhotonClient,
  PhotonRecord,
  QueryState,
  RecordId,
} from '@quantum-box/photon-core'

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
 * A client that serves a fixed set of records and never updates.
 *
 * Storybook uses it so field-subscribing cells (useRecordField) render real
 * values without booting the engine; createBootingPhotonClient stays the
 * choice for surfaces that should render the loading state instead.
 */
export function createStaticRecordClient<T extends { id: string }>(
  values: T[]
): PhotonClient {
  const records = values.map((value) => ({ value }) as PhotonRecord<T>)
  const readyState = { status: 'ready', error: null, pending: false } as const
  const listSnapshot: QueryState<PhotonRecord<T>[]> = {
    data: records,
    ...readyState,
  }
  const recordSnapshots = new Map<string, QueryState<PhotonRecord<T> | null>>()
  for (const record of records) {
    recordSnapshots.set(record.value.id, { data: record, ...readyState })
  }
  const missingRecord: QueryState<PhotonRecord<T> | null> = {
    data: null,
    ...readyState,
  }

  return {
    query: () => constantQuery(listSnapshot),
    liveRecord: (_collection: unknown, recordId: RecordId) =>
      constantQuery(recordSnapshots.get(String(recordId)) ?? missingRecord),
  } as unknown as PhotonClient
}
