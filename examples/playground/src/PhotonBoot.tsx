import { useEffect, useState, type ReactNode } from 'react'
import { PhotonProvider } from '@quantum-box/photon-react'
import type { PhotonClient } from '@quantum-box/photon-core'
import { photonClient } from './lib/photonEngine/client'
import { createBootingPhotonClient } from './lib/photonEngine/bootClient'

/**
 * <PhotonProvider> is mounted before the engine finishes booting, holding a
 * stub client whose queries stay `loading`. Swapping in the real client is a
 * context-value change on an unchanged element tree — mounting the provider
 * only after the client resolved would remount the whole app and wipe chat
 * conversations, workflow drafts, and any other live component state. It
 * would also hold the first paint hostage to engine startup, which runs
 * seconds on a cold cache and worse when several tabs cold-start against the
 * same IndexedDB.
 *
 * WASM load failure is a hard error by design (ADR-0002): there is no JS
 * fallback engine to degrade to, so the app reports it instead of pretending.
 */
export function PhotonBoot({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<PhotonClient>(createBootingPhotonClient)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    photonClient()
      .then((resolved) => {
        if (!cancelled) setClient(resolved)
      })
      .catch((error: unknown) => {
        console.error('Failed to start the Photon engine', error)
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm">
        Failed to start the Photon engine. Reload to retry; if this persists,
        the WASM kernel could not be loaded in this browser.
      </div>
    )
  }

  return <PhotonProvider client={client}>{children}</PhotonProvider>
}
