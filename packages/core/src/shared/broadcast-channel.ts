/**
 * `StoreChannel` over the BroadcastChannel API.
 *
 * The default transport for the leader-elected topology. BroadcastChannel is
 * available in every target Photon ships to — including the Android WebView,
 * where SharedWorker still is not — which is why leader election is the
 * baseline and a SharedWorker is an optimization on top, not the other way
 * round.
 */

import type { StoreChannel, StoreMessage } from './protocol.js'

interface BroadcastChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

interface BroadcastChannelHost {
  BroadcastChannel?: new (name: string) => BroadcastChannelLike
}

export function broadcastChannelAvailable(): boolean {
  return typeof (globalThis as BroadcastChannelHost).BroadcastChannel === 'function'
}

export function createBroadcastStoreChannel(name: string): StoreChannel {
  const ctor = (globalThis as BroadcastChannelHost).BroadcastChannel
  if (!ctor) throw new Error('BroadcastChannel is unavailable')

  const channel = new ctor(name)
  const listeners = new Set<(message: StoreMessage) => void>()

  const onMessage = (event: { data: unknown }): void => {
    const message = event.data as StoreMessage
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return
    // Copied before iterating: a listener may unsubscribe itself, and mutating
    // the set mid-iteration silently skips the next listener.
    for (const listener of [...listeners]) listener(message)
  }
  channel.addEventListener('message', onMessage)

  return {
    post(message) {
      channel.postMessage(message)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      channel.removeEventListener('message', onMessage)
      listeners.clear()
      channel.close()
    },
  }
}
