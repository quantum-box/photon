import { useState } from 'react'
import type { FormEvent } from 'react'
import { appKitConfig } from '../../app/kitConfig'
import { PhotonAuthError } from '../../lib/auth/authClient'
import { useAuth } from '../../contexts/AuthContext'

export function LoginPage({ onSignedIn }: { onSignedIn?: () => void }) {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await signIn({ email, password })
      onSignedIn?.()
    } catch (err: unknown) {
      if (err instanceof PhotonAuthError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-full place-items-center bg-canvas px-4 py-8">
      <section
        className="w-full max-w-sm rounded-md border bg-surface p-5 shadow-soft"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div className="mb-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">txcloud auth</p>
          <h1 className="mt-1 text-xl font-semibold">Sign in to Photon</h1>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-xs font-medium text-muted">Email</span>
            <input
              className="mt-1 w-full rounded border bg-canvas px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              style={{ borderColor: 'var(--border-color)' }}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-muted">Password</span>
            <input
              className="mt-1 w-full rounded border bg-canvas px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              style={{ borderColor: 'var(--border-color)' }}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <div className="grid grid-cols-2 gap-2 text-xs text-muted">
            <div className="min-w-0">
              <span className="block text-subtle">Tenant</span>
              <span className="block truncate">{appKitConfig.auth.tenantId ?? appKitConfig.tenant.id}</span>
            </div>
            <div className="min-w-0">
              <span className="block text-subtle">Auth</span>
              <span className="block truncate">Email and password</span>
            </div>
          </div>

          {error && (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {error}
            </div>
          )}

          <button
            className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            disabled={submitting}
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}
