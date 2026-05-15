import { appKitConfig } from '../../app/kitConfig'
import type { CreateDocInput, DocMetadata, UpdateDocInput } from './types'

export interface ServerDocumentMetadata {
  id: string
  title: string
  workspace_id: string
  created_at: string
  updated_at: string
}

export interface ServerDocumentListResponse {
  documents: ServerDocumentMetadata[]
  total: number
}

export class DocsApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DocsApiError'
    this.status = status
  }
}

function buildApiUrl(path: string) {
  const baseUrl = appKitConfig.server.apiBaseUrl?.replace(/\/$/, '') ?? ''
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new DocsApiError(message || response.statusText, response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

function withoutUndefined<T extends object>(payload: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

export function toDocMetadata(serverDocument: ServerDocumentMetadata): DocMetadata {
  return {
    id: serverDocument.id,
    title: serverDocument.title || appKitConfig.docs.defaultTitle,
    workspaceId: serverDocument.workspace_id || appKitConfig.workspace.id,
    createdAt: serverDocument.created_at,
    updatedAt: serverDocument.updated_at,
  }
}

export async function fetchServerDocuments(): Promise<DocMetadata[]> {
  const params = new URLSearchParams({ workspace_id: appKitConfig.workspace.id })
  const response = await request<ServerDocumentListResponse>(
    `${appKitConfig.server.documentsPath}?${params.toString()}`
  )
  return response.documents.map(toDocMetadata)
}

export async function fetchServerDocument(docId: string): Promise<DocMetadata> {
  const document = await request<ServerDocumentMetadata>(
    `${appKitConfig.server.documentsPath}/${encodeURIComponent(docId)}`
  )
  return toDocMetadata(document)
}

export async function createServerDocument(input: CreateDocInput = {}): Promise<DocMetadata> {
  const document = await request<ServerDocumentMetadata>(appKitConfig.server.documentsPath, {
    method: 'POST',
    body: JSON.stringify(
      withoutUndefined({
        id: input.id,
        title: input.title,
        workspace_id: appKitConfig.workspace.id,
      })
    ),
  })
  return toDocMetadata(document)
}

export async function updateServerDocument(
  docId: string,
  input: UpdateDocInput
): Promise<DocMetadata> {
  const document = await request<ServerDocumentMetadata>(
    `${appKitConfig.server.documentsPath}/${encodeURIComponent(docId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(withoutUndefined({ title: input.title })),
    }
  )
  return toDocMetadata(document)
}
