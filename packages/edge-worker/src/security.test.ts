import { describe, expect, it } from 'vitest'

import {
  MISSING_USER_IDENTITY,
  callerAuthorization,
  closedUnauthenticatedLiveRoute,
} from './security.js'

describe('edge Live security boundary', () => {
  it('fails closed for the public WebSocket path', () => {
    expect(closedUnauthenticatedLiveRoute('/ws')).toEqual({
      status: 403,
      error: 'Photon Edge Live is disabled until authenticated user sessions are enforced',
    })
  })

  it('does not intercept unrelated routes', () => {
    expect(closedUnauthenticatedLiveRoute('/api/health')).toBeNull()
    expect(closedUnauthenticatedLiveRoute('/api/engine/push')).toBeNull()
  })

  it('never substitutes a service credential for a missing caller identity', () => {
    expect(callerAuthorization(null)).toBeNull()
    expect(callerAuthorization('   ')).toBeNull()
    expect(MISSING_USER_IDENTITY.status).toBe(401)
  })

  it('preserves the caller authorization for Engine verification', () => {
    expect(callerAuthorization('Bearer example-user-identity')).toBe(
      'Bearer example-user-identity',
    )
  })
})
