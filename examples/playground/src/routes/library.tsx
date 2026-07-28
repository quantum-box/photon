/* eslint-disable react-refresh/only-export-components */
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { appKitConfig } from '../app/kitConfig'
import { createLibraryClient } from '../lib/libraryClient'
import type { RepoResponse, DataResponse } from '../lib/libraryClient'
import { rootRoute } from './root'

function useLibraryClient() {
  const { apiBaseUrl, serviceToken } = appKitConfig.library
  return createLibraryClient(apiBaseUrl, serviceToken)
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library',
  component: LibraryPage,
})

function LibraryPage() {
  const { apiBaseUrl } = appKitConfig.library
  const [repos, setRepos] = useState<RepoResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useLibraryClient()

  useEffect(() => {
    if (!apiBaseUrl) return
    const loadData = async () => {
      setLoading(true)
      setError(null)
      try {
        const repos = await client.listRepos()
        setRepos(repos)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [apiBaseUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
      <div
        className="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Library</h1>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {!apiBaseUrl && (
          <div
            className="rounded px-4 py-3 text-sm"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
          >
            Library not configured. Set <code>VITE_LIBRARY_API_URL</code> to enable.
          </div>
        )}
        {apiBaseUrl && loading && (
          <div className="text-sm text-muted">Loading repositories…</div>
        )}
        {apiBaseUrl && error && (
          <div className="rounded px-4 py-3 text-sm text-red-500">
            Error: {error}
          </div>
        )}
        {apiBaseUrl && !loading && !error && repos.length === 0 && (
          <div className="text-sm text-muted">No repositories found.</div>
        )}
        {apiBaseUrl && !loading && !error && repos.length > 0 && (
          <ul className="flex flex-col gap-1">
            {repos.map((repo) => (
              <li key={repo.id}>
                <a
                  href={`/library/${encodeURIComponent(repo.username.split('/')[0] ?? repo.username)}/${encodeURIComponent(repo.username)}`}
                  className="flex items-center gap-2 rounded px-3 py-2 text-sm text-muted hover:bg-surface-hover hover:text-foreground no-underline"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                  <span className="font-medium">{repo.name}</span>
                  {repo.description && (
                    <span className="truncate text-subtle text-xs">{repo.description}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export const libraryOrgRepoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library/$org/$repo',
  component: LibraryRepoPage,
})

function LibraryRepoPage() {
  const { org, repo } = libraryOrgRepoRoute.useParams()
  const { apiBaseUrl } = appKitConfig.library
  const [dataList, setDataList] = useState<DataResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useLibraryClient()
  const navigate = useNavigate()

  useEffect(() => {
    if (!apiBaseUrl) return
    const loadData = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await client.listData(org, repo)
        setDataList(data)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [apiBaseUrl, org, repo]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
      <div
        className="flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <button
          className="text-xs text-muted hover:text-foreground"
          onClick={() => void navigate({ to: '/library' })}
        >
          ← Library
        </button>
        <h1 className="text-sm font-semibold">
          {org} / {repo}
        </h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {!apiBaseUrl && (
          <div
            className="rounded px-4 py-3 text-sm"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
          >
            Library not configured. Set <code>VITE_LIBRARY_API_URL</code> to enable.
          </div>
        )}
        {apiBaseUrl && loading && (
          <div className="text-sm text-muted">Loading data…</div>
        )}
        {apiBaseUrl && error && (
          <div className="rounded px-4 py-3 text-sm text-red-500">
            Error: {error}
          </div>
        )}
        {apiBaseUrl && !loading && !error && dataList.length === 0 && (
          <div className="text-sm text-muted">No data entries found.</div>
        )}
        {apiBaseUrl && !loading && !error && dataList.length > 0 && (
          <ul className="flex flex-col gap-1">
            {dataList.map((item) => (
              <li key={item.id}>
                <a
                  href={`/library/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(item.id)}`}
                  className="flex items-center gap-2 rounded px-3 py-2 text-sm text-muted hover:bg-surface-hover hover:text-foreground no-underline"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                  <span className="font-medium">{item.name}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export const libraryDataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library/$org/$repo/$dataId',
  component: LibraryDataPage,
})

function LibraryDataPage() {
  const { org, repo, dataId } = libraryDataRoute.useParams()
  const { apiBaseUrl } = appKitConfig.library
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useLibraryClient()
  const navigate = useNavigate()

  useEffect(() => {
    if (!apiBaseUrl) return
    const loadData = async () => {
      setLoading(true)
      setError(null)
      try {
        const md = await client.getDataMarkdown(org, repo, dataId)
        setMarkdown(md)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [apiBaseUrl, org, repo, dataId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1 md:p-2">
      <div
        className="flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <button
          className="text-xs text-muted hover:text-foreground"
          onClick={() => void navigate({ to: '/library/$org/$repo', params: { org, repo } })}
        >
          ← {org}/{repo}
        </button>
        <h1 className="text-sm font-semibold truncate">{dataId}</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {!apiBaseUrl && (
          <div
            className="rounded px-4 py-3 text-sm"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
          >
            Library not configured. Set <code>VITE_LIBRARY_API_URL</code> to enable.
          </div>
        )}
        {apiBaseUrl && loading && (
          <div className="text-sm text-muted">Loading document…</div>
        )}
        {apiBaseUrl && error && (
          <div className="rounded px-4 py-3 text-sm text-red-500">
            Error: {error}
          </div>
        )}
        {apiBaseUrl && !loading && !error && markdown !== null && (
          <article className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </article>
        )}
      </div>
    </div>
  )
}
