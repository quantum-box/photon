import { appKitConfig } from '../../app/kitConfig'

export interface PhotonAuthSession {
  accessToken: string
  tokenType: 'Bearer'
  expiresAt?: string
  user?: {
    id?: string
    email?: string
    name?: string
  }
}

export interface SignInWithPlatformInput {
  email?: string
  platformToken: string
}

export interface SignInWithPasswordInput {
  email: string
  password: string
}

export class PhotonAuthError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'PhotonAuthError'
    this.status = options.status
    this.code = options.code
  }
}

function normalizeEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim()
  return trimmed ? trimmed.toLowerCase() : undefined
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '')
}

function authUrl(path: string): string {
  const baseUrl = appKitConfig.auth.apiBaseUrl ?? appKitConfig.server.apiBaseUrl ?? ''
  if (!baseUrl) return path
  return `${trimTrailingSlash(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function findToken(payload: unknown): string | undefined {
  const record = asRecord(payload)
  const direct = asText(record.token)
    ?? asText(record.access_token)
    ?? asText(record.accessToken)
    ?? asText(record.id_token)
    ?? asText(record.idToken)
  if (direct) return direct

  for (const key of ['session', 'auth', 'data', 'sign_in_with_platform', 'sign_in_with_password']) {
    const nested = record[key]
    const token = nested ? findToken(nested) : undefined
    if (token) return token
  }

  return undefined
}

function findExpiresAt(payload: unknown): string | undefined {
  const record = asRecord(payload)
  const direct = asText(record.expires_at) ?? asText(record.expiresAt)
  if (direct) return direct

  for (const key of ['session', 'auth', 'data', 'sign_in_with_platform', 'sign_in_with_password']) {
    const nested = record[key]
    const expiresAt = nested ? findExpiresAt(nested) : undefined
    if (expiresAt) return expiresAt
  }

  return undefined
}

function findUser(payload: unknown): PhotonAuthSession['user'] {
  const record = asRecord(payload)
  const user = asRecord(record.user ?? asRecord(record.session).user ?? asRecord(record.data).user)
  if (Object.keys(user).length === 0) return undefined
  return {
    id: asText(user.id) ?? asText(user.user_id) ?? asText(user.userId),
    email: normalizeEmail(asText(user.email)),
    name: asText(user.name) ?? asText(user.display_name) ?? asText(user.displayName),
  }
}

function authPayload(input: SignInWithPlatformInput) {
  return {
    tenant_id: appKitConfig.auth.tenantId,
    operator_id: appKitConfig.auth.operatorId,
    platform_id: appKitConfig.auth.platformId,
    provider_id: appKitConfig.auth.providerId,
    email: normalizeEmail(input.email),
    platform_token: input.platformToken,
  }
}

function passwordAuthPayload(input: SignInWithPasswordInput) {
  return {
    email: normalizeEmail(input.email),
    password: input.password,
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text }
  }
}

function normalizeAuthError(payload: unknown, status?: number): PhotonAuthError {
  const record = asRecord(payload)
  const code = asText(record.code)
    ?? asText(record.error_code)
    ?? asText(asRecord(record.error).code)
  const message = asText(record.message)
    ?? asText(record.error)
    ?? asText(asRecord(record.error).message)
    ?? asText(asRecord(record.errors).message)
    ?? `Authentication failed${status ? ` with HTTP ${status}` : ''}.`
  const isEmailConflict = status === 409
    || code === 'conflict'
    || code === 'duplicate_email'
    || code === 'email_conflict'
    || /duplicate|conflict/i.test(message)
  if (isEmailConflict) {
    return new PhotonAuthError(
      'This email is already associated with another auth identity. Use the existing account or contact an administrator.',
      { status, code: code ?? 'email_conflict' }
    )
  }
  return new PhotonAuthError(message, { status, code })
}

function sessionFromPayload(payload: unknown): PhotonAuthSession {
  const token = findToken(payload)
  if (!token) {
    throw new PhotonAuthError('Authentication response did not include an access token.')
  }
  const record = asRecord(payload)
  return {
    accessToken: token,
    tokenType: 'Bearer',
    expiresAt: findExpiresAt(record),
    user: findUser(payload),
  }
}

async function signInWithRest(input: SignInWithPlatformInput): Promise<PhotonAuthSession> {
  const response = await fetch(authUrl(appKitConfig.auth.restPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(authPayload(input)),
  })
  const payload = await parseResponse(response)
  if (!response.ok) throw normalizeAuthError(payload, response.status)
  return sessionFromPayload(payload)
}

async function signInWithPasswordRest(input: SignInWithPasswordInput): Promise<PhotonAuthSession> {
  const response = await fetch(authUrl(appKitConfig.auth.passwordPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(passwordAuthPayload(input)),
  })
  const payload = await parseResponse(response)
  if (!response.ok) throw normalizeAuthError(payload, response.status)
  return sessionFromPayload(payload)
}

async function signInWithGraphql(input: SignInWithPlatformInput): Promise<PhotonAuthSession> {
  const mutationName = appKitConfig.auth.mutationName
  const response = await fetch(authUrl(appKitConfig.auth.graphqlPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: `mutation SignInWithPlatform($input: SignInWithPlatformInput!) { ${mutationName}(input: $input) { ${appKitConfig.auth.graphqlSelection} } }`,
      variables: { input: authPayload(input) },
    }),
  })
  const payload = await parseResponse(response)
  const errors = Array.isArray(asRecord(payload).errors) ? asRecord(payload).errors as unknown[] : []
  if (!response.ok || errors.length > 0) {
    throw normalizeAuthError(errors[0] ?? payload, response.ok ? undefined : response.status)
  }
  return sessionFromPayload(asRecord(asRecord(payload).data)[mutationName])
}

export async function signInWithPlatform(input: SignInWithPlatformInput): Promise<PhotonAuthSession> {
  if (!input.platformToken.trim()) {
    throw new PhotonAuthError('Platform token is required.')
  }
  return appKitConfig.auth.transport === 'graphql'
    ? signInWithGraphql(input)
    : signInWithRest(input)
}

export async function signInWithPassword(input: SignInWithPasswordInput): Promise<PhotonAuthSession> {
  if (!normalizeEmail(input.email)) {
    throw new PhotonAuthError('Email is required.')
  }
  if (!input.password) {
    throw new PhotonAuthError('Password is required.')
  }
  return signInWithPasswordRest(input)
}
