/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { appKitConfig } from '../app/kitConfig'
import {
  type PhotonAuthSession,
  type SignInWithPasswordInput,
  signInWithPassword,
} from '../lib/auth/authClient'
import {
  authSessionChangedEvent,
  clearAuthSession,
  loadAuthSession,
  saveAuthSession,
} from '../lib/auth/session'

interface AuthContextValue {
  enabled: boolean
  session: PhotonAuthSession | null
  isAuthenticated: boolean
  signIn: (input: SignInWithPasswordInput) => Promise<void>
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PhotonAuthSession | null>(() => loadAuthSession())

  useEffect(() => {
    const sync = () => setSession(loadAuthSession())
    window.addEventListener(authSessionChangedEvent, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(authSessionChangedEvent, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const signIn = useCallback(async (input: SignInWithPasswordInput) => {
    const nextSession = await signInWithPassword(input)
    saveAuthSession(nextSession)
    setSession(nextSession)
  }, [])

  const signOut = useCallback(() => {
    clearAuthSession()
    setSession(null)
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    enabled: appKitConfig.auth.enabled,
    session,
    isAuthenticated: !appKitConfig.auth.enabled || Boolean(session?.accessToken),
    signIn,
    signOut,
  }), [session, signIn, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
