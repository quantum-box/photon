/**
 * Typed fetch wrapper for the Library API.
 *
 * Endpoints covered:
 *   GET /v1beta/repos              — list repos (array of RepoResponse)
 *   GET /v1beta/orgs/{org}         — org detail with repos
 *   GET /v1beta/repos/{org}/{repo}/data-list  — list data entries
 *   GET /v1beta/repos/{org}/{repo}/data/{data_id}/md — raw markdown (text/markdown)
 *   GET /docs/{org}/{repo}/{data_id}/md — public markdown (text/markdown, no auth)
 *
 * Auth: Authorization: Bearer {serviceToken} when serviceToken is present.
 */
import { photonApiFetch } from './apiClient'

// ── Types from OpenAPI spec ────────────────────────────────────

export interface RepoResponse {
  id: string
  name: string
  username: string
  is_public: boolean
  organization_id: string
  description?: string | null
}

export interface OrganizationResponse {
  id: string
  name: string
  username: string
  repos: RepoResponse[]
  description?: string | null
  website?: string | null
}

export interface DataResponse {
  id: string
  name: string
  items: PropertyDataResponse[]
}

export interface PropertyDataResponse {
  property_id: string
  key: string
  value?: PropertyDataValue | null
}

export type PropertyDataValue =
  | { string: string }
  | { integer: number }
  | { html: string }
  | { markdown: string }
  | { relation: { database_id: string; data_id: string[] } }
  | { id: string }
  | { select: string }
  | { multiSelect: string[] }
  | { location: { latitude: number; longitude: number } }
  | { date: string }
  | { image: string }

// ── Client interface ───────────────────────────────────────────

export interface LibraryClient {
  /** GET /v1beta/repos — list repos accessible to the caller */
  listRepos(): Promise<RepoResponse[]>

  /** GET /v1beta/orgs/{org} — org detail including repos list */
  getOrg(org: string): Promise<OrganizationResponse>

  /** GET /v1beta/repos/{org}/{repo}/data-list — list all data entries in a repo */
  listData(org: string, repo: string): Promise<DataResponse[]>

  /** GET /v1beta/repos/{org}/{repo}/data/{data_id}/md — raw markdown content */
  getDataMarkdown(org: string, repo: string, dataId: string): Promise<string>
}

// ── Factory ────────────────────────────────────────────────────

/**
 * Create a LibraryClient.
 *
 * If `baseUrl` is empty or undefined, every method call will throw a clear
 * configuration error (graceful degradation — the UI shows an error message
 * rather than crashing at construction time).
 */
export function createLibraryClient(baseUrl: string | undefined, serviceToken?: string): LibraryClient {
  const resolvedBase = baseUrl ?? ''

  const assertConfigured = () => {
    if (!resolvedBase) {
      throw new Error('Library API base URL is not configured. Set VITE_LIBRARY_API_URL.')
    }
  }

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`
    return headers
  }

  const fetchJson = async <T>(path: string): Promise<T> => {
    assertConfigured()
    const url = `${resolvedBase.replace(/\/$/, '')}${path}`
    const response = await photonApiFetch(url, { headers: authHeaders() })
    if (!response.ok) {
      throw new Error(`Library API error ${response.status}: ${response.statusText} (${url})`)
    }
    return response.json() as Promise<T>
  }

  const fetchText = async (path: string): Promise<string> => {
    assertConfigured()
    const url = `${resolvedBase.replace(/\/$/, '')}${path}`
    const headers: Record<string, string> = {}
    if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`
    const response = await photonApiFetch(url, { headers })
    if (!response.ok) {
      throw new Error(`Library API error ${response.status}: ${response.statusText} (${url})`)
    }
    return response.text()
  }

  return {
    listRepos: () => fetchJson<RepoResponse[]>('/v1beta/repos'),
    getOrg: (org) => fetchJson<OrganizationResponse>(`/v1beta/orgs/${encodeURIComponent(org)}`),
    listData: (org, repo) =>
      fetchJson<DataResponse[]>(
        `/v1beta/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/data-list`,
      ),
    getDataMarkdown: (org, repo, dataId) =>
      fetchText(
        `/v1beta/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/data/${encodeURIComponent(dataId)}/md`,
      ),
  }
}
