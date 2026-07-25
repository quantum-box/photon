import { useState, useEffect, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import {
  recordsArray,
  initialSyncReady,
  connectionStatus,
  syncPresence,
  type ConnectionStatus,
  type SyncPresence,
} from './yjsProvider'
import type { DatabaseRecord, Status, Priority } from '../../data/mock'

// ---------------------------------------------------------------------------
// Y.Map → Record conversion
// ---------------------------------------------------------------------------

function ymapToRecord(ymap: Y.Map<string>): DatabaseRecord {
  const labelsRaw = ymap.get('labels') as string | undefined
  let labels: string[] = []
  if (labelsRaw) {
    try {
      labels = JSON.parse(labelsRaw) as string[]
    } catch {
      labels = []
    }
  }

  return {
    id: (ymap.get('id') as string) ?? '',
    identifier: (ymap.get('identifier') as string) ?? '',
    title: (ymap.get('title') as string) ?? '',
    status: (ymap.get('status') as Status) ?? 'backlog',
    priority: (ymap.get('priority') as Priority) ?? 'none',
    assignee: (ymap.get('assignee') as string) || null,
    labels,
    project: (ymap.get('project') as string) ?? '',
    createdAt: (ymap.get('createdAt') as string) ?? '',
    updatedAt: (ymap.get('updatedAt') as string) ?? '',
    description: (ymap.get('description') as string) ?? '',
  }
}

function snapshot(): DatabaseRecord[] {
  const result = new Map<string, DatabaseRecord>()
  recordsArray.forEach((ymap) => {
    const record = ymapToRecord(ymap)
    if (record.id) {
      result.set(record.id, record)
    }
  })
  return [...result.values()]
}

// ---------------------------------------------------------------------------
// useYjsRecords — React hook
// ---------------------------------------------------------------------------

export function useYjsRecords(): { records: DatabaseRecord[]; ready: boolean } {
  const [records, setRecords] = useState<DatabaseRecord[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let rafId: number | null = null
    let unmounted = false
    let observing = false

    function debouncedSnapshot() {
      if (unmounted) return
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!unmounted) setRecords(snapshot())
      })
    }

    // Wait for initial sync, then take first snapshot and start observing
    initialSyncReady.then(() => {
      if (unmounted) return
      setRecords(snapshot())
      setReady(true)
      recordsArray.observeDeep(debouncedSnapshot)
      observing = true
    })

    return () => {
      unmounted = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (observing) {
        recordsArray.unobserveDeep(debouncedSnapshot)
      }
    }
  }, [])

  return { records, ready }
}

// ---------------------------------------------------------------------------
// useConnectionStatus — React hook
// ---------------------------------------------------------------------------

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    connectionStatus.subscribe,
    () => connectionStatus.value,
  )
}

export function useSyncPresence(): SyncPresence {
  return useSyncExternalStore(
    syncPresence.subscribe,
    () => syncPresence.value,
  )
}
