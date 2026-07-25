import { appKitConfig } from '../app/kitConfig'
import { clearAuthSession, getAuthToken } from './auth/session'

function withApiBaseUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (!(typeof input === 'string')) return input
  if (!input.startsWith('/')) return input
  const baseUrl = appKitConfig.server.apiBaseUrl
  return baseUrl ? `${baseUrl.replace(/\/$/, '')}${input}` : input
}

function withAuthHeaders(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers)
  const token = getAuthToken()
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return { ...init, headers }
}

export async function photonApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(withApiBaseUrl(input), withAuthHeaders(init))
  if (appKitConfig.auth.enabled && response.status === 401) {
    clearAuthSession()
  }
  return response
}

export function buildApiUrl(path: string): string {
  const url = withApiBaseUrl(path)
  return typeof url === 'string' ? url : url.toString()
}
