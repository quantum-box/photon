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

// ── Implementation ─────────────────────────────────────────────

class LibraryClientImpl implements LibraryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken?: string,
  ) {}

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (this.serviceToken) {
      headers['Authorization'] = `Bearer ${this.serviceToken}`
    }
    return headers
  }

  private assertConfigured(): void {
    if (!this.baseUrl) {
      throw new Error('Library API base URL is not configured. Set VITE_LIBRARY_API_URL.')
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    this.assertConfigured()
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const response = await fetch(url, { headers: this.headers() })
    if (!response.ok) {
      throw new Error(`Library API error ${response.status}: ${response.statusText} (${url})`)
    }
    return response.json() as Promise<T>
  }

  private async fetchText(path: string): Promise<string> {
    this.assertConfigured()
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const headers: Record<string, string> = {}
    if (this.serviceToken) {
      headers['Authorization'] = `Bearer ${this.serviceToken}`
    }
    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new Error(`Library API error ${response.status}: ${response.statusText} (${url})`)
    }
    return response.text()
  }

  listRepos(): Promise<RepoResponse[]> {
    return this.fetchJson<RepoResponse[]>('/v1beta/repos')
  }

  getOrg(org: string): Promise<OrganizationResponse> {
    return this.fetchJson<OrganizationResponse>(`/v1beta/orgs/${encodeURIComponent(org)}`)
  }

  listData(org: string, repo: string): Promise<DataResponse[]> {
    return this.fetchJson<DataResponse[]>(
      `/v1beta/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/data-list`
    )
  }

  getDataMarkdown(org: string, repo: string, dataId: string): Promise<string> {
    return this.fetchText(
      `/v1beta/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/data/${encodeURIComponent(dataId)}/md`
    )
  }
}

// ── Factory ────────────────────────────────────────────────────

/**
 * Create a LibraryClient.
 *
 * If `baseUrl` is empty or undefined, the client is constructed but every
 * method call will throw a clear configuration error (graceful degradation —
 * the UI shows an error message rather than crashing).
 */
export function createLibraryClient(baseUrl: string | undefined, serviceToken?: string): LibraryClient {
  return new LibraryClientImpl(baseUrl ?? '', serviceToken)
}
