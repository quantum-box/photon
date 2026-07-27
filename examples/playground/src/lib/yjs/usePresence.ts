import { useSyncExternalStore } from 'react'
import {
  connectionStatus,
  syncPresence,
  type ConnectionStatus,
  type SyncPresence,
} from './yjsProvider'

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
