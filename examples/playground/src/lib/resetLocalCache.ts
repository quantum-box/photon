/**
 * Local cache reset for the playground.
 *
 * ADR-0002 removed the Yjs structured-data array, which orphans whatever a
 * returning browser still holds in the workspace Y.Doc's IndexedDB — and a
 * corrupted engine database has no other way out either. This wipes both
 * local stores; the next load re-hydrates from the server. Server-side data
 * is untouched.
 */
import { appKitConfig } from '../app/kitConfig'
import { persistence, disconnectWs } from './yjs/yjsProvider'
import { photonClient } from './photonEngine/client'

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    // `blocked` means another tab still holds the database open; the deletion
    // completes once that tab goes away. Reloading regardless is fine.
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
}

export async function resetLocalCache(): Promise<void> {
  // Stop the writers first so the databases can actually be deleted.
  disconnectWs()
  await persistence.destroy()
  try {
    const client = await photonClient()
    client.sync.stop()
    await client.storage.close()
  } catch {
    // A client that failed to start holds no locks worth releasing.
  }

  const engineDbName = appKitConfig.engine.pgliteDataDir.replace('idb://', '')
  const databases = await indexedDB.databases()
  const doomed = databases
    .map((db) => db.name)
    .filter((name): name is string => Boolean(name))
    .filter(
      (name) => name.includes(engineDbName) || name === appKitConfig.sync.persistenceKey,
    )

  await Promise.all(doomed.map(deleteIndexedDb))
}
