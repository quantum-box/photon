import { appKitConfig } from '../../app/kitConfig'
import type { PhotonAuthSession } from './authClient'

export const authSessionChangedEvent = 'photon-auth-session-changed'

export function loadAuthSession(): PhotonAuthSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(appKitConfig.auth.tokenStorageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PhotonAuthSession>
    return typeof parsed.accessToken === 'string' && parsed.accessToken
      ? { ...parsed, accessToken: parsed.accessToken, tokenType: 'Bearer' }
      : null
  } catch {
    return null
  }
}

export function saveAuthSession(session: PhotonAuthSession): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(appKitConfig.auth.tokenStorageKey, JSON.stringify(session))
  window.dispatchEvent(new Event(authSessionChangedEvent))
}

export function clearAuthSession(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(appKitConfig.auth.tokenStorageKey)
  window.dispatchEvent(new Event(authSessionChangedEvent))
}

export function getAuthToken(): string | null {
  return loadAuthSession()?.accessToken ?? null
}
