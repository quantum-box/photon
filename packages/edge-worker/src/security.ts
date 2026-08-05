export interface ClosedLiveRoute {
  readonly status: 403
  readonly error: string
}

export const CLOSED_UNAUTHENTICATED_LIVE_ROUTE: ClosedLiveRoute = {
  status: 403,
  error: 'Photon Edge Live is disabled until authenticated user sessions are enforced',
}

export const MISSING_USER_IDENTITY = {
  status: 401 as const,
  error: 'Photon Edge Engine proxy requires caller authorization',
}

export function callerAuthorization(value: string | null): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

/**
 * The Durable Object relay has no user authenticator yet. Keep its public
 * route closed until the principal-aware Live boundary is implemented; an
 * environment flag or service credential alone must never open browser writes.
 */
export function closedUnauthenticatedLiveRoute(pathname: string): ClosedLiveRoute | null {
  if (pathname !== '/ws') return null
  return CLOSED_UNAUTHENTICATED_LIVE_ROUTE
}
