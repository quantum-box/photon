/**
 * The wire between a shared store's owner and its followers.
 *
 * Deliberately transport-shaped rather than BroadcastChannel-shaped. The same
 * protocol carries all three topologies we need: a leader-elected tab talking
 * over BroadcastChannel, a SharedWorker talking over MessagePort, and Tauri's
 * Rust-side store talking over IPC. Only `StoreChannel` differs between them —
 * which is the whole reason `LocalStore` was kept to ~10 methods.
 */

import type { StoreWrite } from '../store.js'

/**
 * A broadcast message bus: every peer sees every message, and a peer never
 * sees its own posts.
 *
 * Broadcast rather than addressed on purpose. A follower that has just booted
 * does not know which context owns the store, and with a broadcast bus it
 * never has to: it shouts, and whichever context holds ownership answers.
 */
export interface StoreChannel {
  post(message: StoreMessage): void
  subscribe(listener: (message: StoreMessage) => void): () => void
  close(): void
}

/**
 * The `LocalStore` methods a follower forwards.
 *
 * `raw()` and `close()` are absent by design. `raw()` hands back a live
 * database handle, which cannot cross a message boundary — a follower returns
 * `null` instead. `close()` must stay local, or the first tab to close would
 * take everyone else's store down with it.
 */
export type RemoteMethod =
  | 'migrate'
  | 'loadRecords'
  | 'loadPendingOperations'
  | 'loadAcceptedOperations'
  | 'loadOperationIds'
  | 'loadConflicts'
  | 'getCursor'
  | 'readRecordPage'
  | 'getSelectionState'
  | 'getSelectionMembers'
  | 'getRecordMemberships'
  | 'getRecordBase'
  | 'getDeferredEviction'
  | 'commit'
  | 'stats'

export interface RequestMessage {
  readonly t: 'req'
  readonly id: string
  readonly from: string
  readonly method: RemoteMethod
  readonly args: readonly unknown[]
}

export interface ResponseMessage {
  readonly t: 'res'
  readonly id: string
  readonly from: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly name: string; readonly message: string }
}

/**
 * The owner announcing itself.
 *
 * `serving: true` also means "re-send anything in flight": a promoted owner
 * never saw the requests the dead one was holding, so without this they would
 * sit until their timeout for no reason.
 *
 * `serving: false` is the more important one. An elected owner announces
 * before it opens its database, which can take tens of seconds on slow
 * hardware. That announcement is what tells a follower the difference between
 * "the owner is coming" and "there is no owner" — without it, a follower
 * fails a perfectly good request for the crime of asking during a cold start.
 */
export interface HelloMessage {
  readonly t: 'hello'
  readonly from: string
  readonly serving: boolean
}

/** A follower asking whether anyone is serving yet. The owner replies `hello`. */
export interface WhoMessage {
  readonly t: 'who'
  readonly from: string
}

/**
 * A write that reached the real store.
 *
 * Carries `from` so the context that issued it can ignore its own echo: that
 * context already applied the change to its own projection when it made the
 * mutation, and re-applying would emit a spurious remote change.
 */
export interface WriteMessage {
  readonly t: 'write'
  readonly from: string
  readonly write: StoreWrite
}

export type StoreMessage =
  | RequestMessage
  | ResponseMessage
  | HelloMessage
  | WhoMessage
  | WriteMessage

/** Errors have to survive structured clone, which drops the prototype. */
export function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

export function deserializeError(payload: { name: string; message: string } | undefined): Error {
  const error = new Error(payload?.message ?? 'the shared store owner failed the request')
  error.name = payload?.name ?? 'Error'
  return error
}
