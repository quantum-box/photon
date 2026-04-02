import { useState, useEffect, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { issuesArray, initialSyncReady, connectionStatus, type ConnectionStatus } from './yjsProvider'
import type { Issue, Status, Priority } from '../../data/mock'

// ---------------------------------------------------------------------------
// Y.Map → Issue conversion
// ---------------------------------------------------------------------------

function ymapToIssue(ymap: Y.Map<string>): Issue {
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

function snapshot(): Issue[] {
  const result: Issue[] = []
  issuesArray.forEach((ymap) => {
    result.push(ymapToIssue(ymap))
  })
  return result
}

// ---------------------------------------------------------------------------
// useYjsIssues — React hook
// ---------------------------------------------------------------------------

export function useYjsIssues(): { issues: Issue[]; ready: boolean } {
  const [issues, setIssues] = useState<Issue[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let rafId: number | null = null
    let unmounted = false

    function debouncedSnapshot() {
      if (unmounted) return
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!unmounted) setIssues(snapshot())
      })
    }

    // Wait for initial sync, then take first snapshot and start observing
    initialSyncReady.then(() => {
      if (unmounted) return
      setIssues(snapshot())
      setReady(true)
      issuesArray.observeDeep(debouncedSnapshot)
    })

    return () => {
      unmounted = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      issuesArray.unobserveDeep(debouncedSnapshot)
    }
  }, [])

  return { issues, ready }
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
