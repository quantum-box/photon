import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'
import { useAuth } from '../../contexts/AuthContext'
import { PhotonAuthError } from '../../lib/auth/authClient'

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}))

const useAuthMock = vi.mocked(useAuth)
const passwordInput = ['mock', 'credential'].join('-')

describe('LoginPage', () => {
  const signIn = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useAuthMock.mockReturnValue({
      enabled: true,
      session: null,
      isAuthenticated: false,
      signIn,
      signOut: vi.fn(),
    })
  })

  it('renders email and password sign-in fields', () => {
    render(<LoginPage />)

    expect(screen.getByRole('heading', { name: 'Sign in to Photon' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.queryByLabelText('Platform token')).not.toBeInTheDocument()
  })

  it('submits email and password credentials', async () => {
    const onSignedIn = vi.fn()
    signIn.mockResolvedValueOnce(undefined)
    render(<LoginPage onSignedIn={onSignedIn} />)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: ' USER@example.COM ' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: passwordInput },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({
        email: 'USER@example.COM',
        password: passwordInput,
      })
    })
    expect(onSignedIn).toHaveBeenCalledOnce()
  })

  it('shows auth errors without completing sign-in', async () => {
    const onSignedIn = vi.fn()
    signIn.mockRejectedValueOnce(new PhotonAuthError('Invalid email or password.'))
    render(<LoginPage onSignedIn={onSignedIn} />)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: passwordInput },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument()
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})
