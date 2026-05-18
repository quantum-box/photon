import { afterEach, describe, expect, it, vi } from 'vitest'
import { photonApiFetch } from './apiClient'
import { clearAuthSession, saveAuthSession } from './auth/session'

describe('photonApiFetch', () => {
  afterEach(() => {
    clearAuthSession()
    vi.restoreAllMocks()
  })

  it('adds the stored Bearer token to API requests', async () => {
    saveAuthSession({ accessToken: 'stored-token', tokenType: 'Bearer' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    await photonApiFetch('/api/engine/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer stored-token')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('does not replace an explicit Authorization header', async () => {
    saveAuthSession({ accessToken: 'stored-token', tokenType: 'Bearer' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    await photonApiFetch('https://library.example/v1beta/repos', {
      headers: { Authorization: 'Bearer service-token' },
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token')
  })
})
