import { PGlite } from '@electric-sql/pglite'
import { appKitConfig } from '../../app/kitConfig'
import type {
  CreateDocInput,
  DocMetadata,
  DocumentRecordLink,
  LinkDocRecordInput,
  UpdateDocInput,
} from './types'

interface DocRow {
  id: string
  title: string
  workspace_id: string
  created_at: string
  updated_at: string
}

interface DocumentRecordLinkRow {
  id: string
  doc_id: string
  doc_title?: string
  record_id: string
  record_identifier: string
  record_title: string
  selected_text: string
  created_at: string
}

type DocsListener = () => void
interface CacheDocOptions {
  emit?: boolean
}

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

    CREATE TABLE IF NOT EXISTS document_record_links (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_identifier TEXT NOT NULL,
      record_title TEXT NOT NULL,
      selected_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (doc_id, record_id)
    );

    CREATE INDEX IF NOT EXISTS document_record_links_doc_idx
      ON document_record_links (doc_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS document_record_links_record_idx
      ON document_record_links (record_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS document_record_links_identifier_idx
      ON document_record_links (record_identifier, created_at DESC);
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

function toDocumentRecordLink(row: DocumentRecordLinkRow): DocumentRecordLink {
  return {
    id: row.id,
    docId: row.doc_id,
    docTitle: row.doc_title,
    recordId: row.record_id,
    recordIdentifier: row.record_identifier,
    recordTitle: row.record_title,
    selectedText: row.selected_text,
    createdAt: row.created_at,
  }
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

export async function cacheDocMetadata(
  doc: DocMetadata,
  options: CacheDocOptions = {}
): Promise<void> {
  const db = await dbPromise
  await db.query(
    `
      INSERT INTO documents (id, title, workspace_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        workspace_id = EXCLUDED.workspace_id,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `,
    [doc.id, doc.title, doc.workspaceId, doc.createdAt, doc.updatedAt]
  )

  if (options.emit ?? true) {
    emitDocsChanged()
  }
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

export async function linkDocRecord(input: LinkDocRecordInput): Promise<DocumentRecordLink> {
  const db = await dbPromise
  const now = new Date().toISOString()
  const link = {
    id: globalThis.crypto?.randomUUID?.() ?? `doc-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    docId: input.docId,
    recordId: input.recordId,
    recordIdentifier: input.recordIdentifier,
    recordTitle: input.recordTitle,
    selectedText: input.selectedText?.trim() ?? '',
    createdAt: now,
  }

  const result = await db.query<DocumentRecordLinkRow>(
    `
      INSERT INTO document_record_links (
        id, doc_id, record_id, record_identifier, record_title, selected_text, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (doc_id, record_id) DO UPDATE SET
        record_identifier = EXCLUDED.record_identifier,
        record_title = EXCLUDED.record_title,
        selected_text = CASE
          WHEN EXCLUDED.selected_text <> '' THEN EXCLUDED.selected_text
          ELSE document_record_links.selected_text
        END
      RETURNING id, doc_id, record_id, record_identifier, record_title, selected_text, created_at
    `,
    [
      link.id,
      link.docId,
      link.recordId,
      link.recordIdentifier,
      link.recordTitle,
      link.selectedText,
      link.createdAt,
    ]
  )

  await touchDoc(input.docId)
  return toDocumentRecordLink(result.rows[0])
}

export async function listDocRecordLinks(docId: string): Promise<DocumentRecordLink[]> {
  const db = await dbPromise
  const result = await db.query<DocumentRecordLinkRow>(
    `
      SELECT id, doc_id, record_id, record_identifier, record_title, selected_text, created_at
      FROM document_record_links
      WHERE doc_id = $1
      ORDER BY created_at DESC
    `,
    [docId]
  )
  return result.rows.map(toDocumentRecordLink)
}

export async function listRecordDocLinks(recordId: string, recordIdentifier: string): Promise<DocumentRecordLink[]> {
  const db = await dbPromise
  const result = await db.query<DocumentRecordLinkRow>(
    `
      SELECT
        document_record_links.id,
        document_record_links.doc_id,
        documents.title AS doc_title,
        document_record_links.record_id,
        document_record_links.record_identifier,
        document_record_links.record_title,
        document_record_links.selected_text,
        document_record_links.created_at
      FROM document_record_links
      LEFT JOIN documents ON documents.id = document_record_links.doc_id
      WHERE document_record_links.record_id = $1 OR document_record_links.record_identifier = $2
      ORDER BY document_record_links.created_at DESC
    `,
    [recordId, recordIdentifier]
  )
  return result.rows.map(toDocumentRecordLink)
}
