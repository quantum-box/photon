import { PGlite } from '@electric-sql/pglite'
import { appKitConfig } from '../../app/kitConfig'
import type { CreateDocInput, DocMetadata, UpdateDocInput } from './types'

interface DocRow {
  id: string
  title: string
  workspace_id: string
  created_at: string
  updated_at: string
}

type DocsListener = () => void

const listeners = new Set<DocsListener>()

const dbPromise = PGlite.create(appKitConfig.docs.pgliteDataDir).then(async (db) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS documents_workspace_updated_idx
      ON documents (workspace_id, updated_at DESC);
  `)
  return db
})

function toDoc(row: DocRow): DocMetadata {
  return {
    id: row.id,
    title: row.title,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function emitDocsChanged() {
  listeners.forEach((listener) => listener())
}

export function subscribeDocs(listener: DocsListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function listDocs(): Promise<DocMetadata[]> {
  const db = await dbPromise
  const result = await db.query<DocRow>(
    `
      SELECT id, title, workspace_id, created_at, updated_at
      FROM documents
      WHERE workspace_id = $1
      ORDER BY updated_at DESC
    `,
    [appKitConfig.workspace.id]
  )
  return result.rows.map(toDoc)
}

export async function getDoc(docId: string): Promise<DocMetadata | null> {
  const db = await dbPromise
  const result = await db.query<DocRow>(
    `
      SELECT id, title, workspace_id, created_at, updated_at
      FROM documents
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1
    `,
    [docId, appKitConfig.workspace.id]
  )
  return result.rows[0] ? toDoc(result.rows[0]) : null
}

export async function createDoc(input: CreateDocInput = {}): Promise<DocMetadata> {
  const db = await dbPromise
  const now = new Date().toISOString()
  const doc: DocMetadata = {
    id: input.id ?? globalThis.crypto?.randomUUID?.() ?? `doc-${Date.now()}`,
    title: input.title?.trim() || appKitConfig.docs.defaultTitle,
    workspaceId: appKitConfig.workspace.id,
    createdAt: now,
    updatedAt: now,
  }

  await db.query(
    `
      INSERT INTO documents (id, title, workspace_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [doc.id, doc.title, doc.workspaceId, doc.createdAt, doc.updatedAt]
  )

  emitDocsChanged()
  return doc
}

export async function ensureDoc(docId: string): Promise<DocMetadata> {
  const existing = await getDoc(docId)
  if (existing) return existing

  return createDoc({
    id: docId,
    title: 'Shared document',
  })
}

export async function updateDoc(docId: string, input: UpdateDocInput): Promise<DocMetadata | null> {
  const existing = await getDoc(docId)
  if (!existing) return null

  const db = await dbPromise
  const nextTitle = input.title?.trim() || appKitConfig.docs.defaultTitle
  const updatedAt = new Date().toISOString()

  const result = await db.query<DocRow>(
    `
      UPDATE documents
      SET title = $1, updated_at = $2
      WHERE id = $3 AND workspace_id = $4
      RETURNING id, title, workspace_id, created_at, updated_at
    `,
    [nextTitle, updatedAt, docId, appKitConfig.workspace.id]
  )

  emitDocsChanged()
  return result.rows[0] ? toDoc(result.rows[0]) : null
}

export async function touchDoc(docId: string): Promise<void> {
  const db = await dbPromise
  await db.query(
    `
      UPDATE documents
      SET updated_at = $1
      WHERE id = $2 AND workspace_id = $3
    `,
    [new Date().toISOString(), docId, appKitConfig.workspace.id]
  )
  emitDocsChanged()
}
