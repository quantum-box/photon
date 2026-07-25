import { afterEach, describe, expect, it, vi } from 'vitest'
import { signInWithPlatform } from './authClient'

describe('signInWithPlatform', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts normalized identity data to the REST sign-in endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'auth-token',
        user: { id: 'user-1', email: 'USER@example.COM' },
      }), { status: 200 })
    )

    const session = await signInWithPlatform({
      email: ' USER@example.COM ',
      platformToken: 'platform-token',
    })

    expect(session.accessToken).toBe('auth-token')
    expect(session.user?.email).toBe('user@example.com')
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: 'user@example.com',
      platform_token: 'platform-token',
    })
  })

  it('normalizes duplicate email conflicts from the auth platform', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        code: 'duplicate_email',
        message: 'normalized email already exists',
      }), { status: 409 })
    )

    await expect(signInWithPlatform({
      email: 'taken@example.com',
      platformToken: 'platform-token',
    })).rejects.toMatchObject({
      code: 'duplicate_email',
      status: 409,
    })
  })
})
