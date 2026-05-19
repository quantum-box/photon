import { afterEach, describe, expect, it, vi } from 'vitest'
import { signInWithPassword } from './authClient'

const passwordInput = ['mock', 'credential'].join('-')
const accessToken = ['auth', 'token'].join('-')
const nestedAccessToken = ['nested', 'auth', 'token'].join('-')

describe('signInWithPassword', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts normalized email and password to the password sign-in endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        access_token: accessToken,
        user: { id: 'user-1', email: 'USER@example.COM' },
      }), { status: 200 })
    )

    const session = await signInWithPassword({
      email: ' USER@example.COM ',
      password: passwordInput,
    })

    expect(session.accessToken).toBe(accessToken)
    expect(session.tokenType).toBe('Bearer')
    expect(session.user?.email).toBe('user@example.com')
    const [url, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(url).toBe('/auth/v1beta/sign-in-with-password')
    expect(body).toEqual({
      email: 'user@example.com',
      password: passwordInput,
    })
  })

  it('extracts a Bearer token from the password sign-in response envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          sign_in_with_password: {
            token: nestedAccessToken,
            expires_at: '2026-05-19T00:00:00Z',
          },
        },
      }), { status: 200 })
    )

    await expect(signInWithPassword({
      email: 'user@example.com',
      password: passwordInput,
    })).resolves.toMatchObject({
      accessToken: nestedAccessToken,
      tokenType: 'Bearer',
      expiresAt: '2026-05-19T00:00:00Z',
    })
  })

  it('normalizes failed password sign-in responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        code: 'invalid_credentials',
        message: 'Invalid email or password.',
      }), { status: 401 })
    )

    await expect(signInWithPassword({
      email: 'user@example.com',
      password: passwordInput,
    })).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
      message: 'Invalid email or password.',
    })
  })

  it('requires email and password before calling the endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(signInWithPassword({
      email: '',
      password: passwordInput,
    })).rejects.toThrow('Email is required.')
    await expect(signInWithPassword({
      email: 'user@example.com',
      password: '',
    })).rejects.toThrow('Password is required.')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
