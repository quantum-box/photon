/**
 * Which context owns the real store.
 *
 * Web Locks, queued rather than `ifAvailable`. The opt-in `exclusiveLock` in
 * the PGlite adapter uses `ifAvailable` because its only job is to fail the
 * second tab loudly; here the second tab is supposed to wait, and be promoted
 * the moment the owner's tab goes away. That handover is the entire difference
 * between "the second tab refuses to open" and "multi-tab works".
 */

export interface Election {
  /** True once this context holds the lock. */
  readonly isOwner: boolean
  close(): void
}

interface WebLockManager {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ): Promise<unknown>
}

interface WebLocksHost {
  navigator?: { locks?: WebLockManager }
}

export function webLocksAvailable(): boolean {
  return Boolean((globalThis as WebLocksHost).navigator?.locks)
}

/**
 * Queue for ownership of `name`, calling `onWin` if and when it is granted.
 *
 * Without the Web Locks API — Node, older WebViews — there is no way to elect
 * anything, so this context takes ownership immediately and warns. That is the
 * same degradation the PGlite adapter already makes: a single-context host is
 * the common case there, and pretending to coordinate would be worse than
 * saying plainly that we are not.
 */
export function electOwner(name: string, onWin: () => void): Election {
  const locks = (globalThis as WebLocksHost).navigator?.locks

  if (!locks) {
    console.warn(
      `Photon: the Web Locks API is unavailable, so ownership of ${name} cannot be elected. ` +
        'Taking ownership in this context. If more than one context opens this store, they will corrupt it.',
    )
    let owner = true
    onWin()
    return {
      get isOwner() {
        return owner
      },
      close() {
        owner = false
      },
    }
  }

  const controller = new AbortController()
  let owner = false
  let release: (() => void) | null = null

  void locks
    .request(name, { signal: controller.signal }, async () => {
      owner = true
      onWin()
      // Holding the lock *is* owning the store, so the callback must not
      // resolve until this context gives ownership up.
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    .catch((error: unknown) => {
      // Aborting a still-queued request is how `close()` withdraws from the
      // election, so that rejection is expected, not a failure.
      if (controller.signal.aborted) return
      console.error(`Photon: ownership election for ${name} failed`, error)
    })

  return {
    get isOwner() {
      return owner
    },
    close() {
      owner = false
      // Exactly one of these applies: `release` if the lock was granted,
      // `abort` if this context is still queued behind another.
      if (release) release()
      else controller.abort()
    },
  }
}
