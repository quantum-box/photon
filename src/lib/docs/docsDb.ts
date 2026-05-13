import { PGlite } from '@electric-sql/pglite'
import { appKitConfig } from '../../app/kitConfig'
import type {
  CreateDocInput,
  DocMetadata,
  DocumentIssueLink,
  LinkDocIssueInput,
  UpdateDocInput,
} from './types'

interface DocRow {
  id: string
  title: string
  workspace_id: string
  created_at: string
  updated_at: string
}

interface DocumentIssueLinkRow {
  id: string
  doc_id: string
  doc_title?: string
  issue_id: string
  issue_identifier: string
  issue_title: string
  selected_text: string
  created_at: string
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

    CREATE TABLE IF NOT EXISTS document_issue_links (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      issue_title TEXT NOT NULL,
      selected_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (doc_id, issue_id)
    );

    CREATE INDEX IF NOT EXISTS document_issue_links_doc_idx
      ON document_issue_links (doc_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS document_issue_links_issue_idx
      ON document_issue_links (issue_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS document_issue_links_identifier_idx
      ON document_issue_links (issue_identifier, created_at DESC);
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

function toDocumentIssueLink(row: DocumentIssueLinkRow): DocumentIssueLink {
  return {
    id: row.id,
    docId: row.doc_id,
    docTitle: row.doc_title,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    issueTitle: row.issue_title,
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

export async function linkDocIssue(input: LinkDocIssueInput): Promise<DocumentIssueLink> {
  const db = await dbPromise
  const now = new Date().toISOString()
  const link = {
    id: globalThis.crypto?.randomUUID?.() ?? `doc-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    docId: input.docId,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    issueTitle: input.issueTitle,
    selectedText: input.selectedText?.trim() ?? '',
    createdAt: now,
  }

  const result = await db.query<DocumentIssueLinkRow>(
    `
      INSERT INTO document_issue_links (
        id, doc_id, issue_id, issue_identifier, issue_title, selected_text, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (doc_id, issue_id) DO UPDATE SET
        issue_identifier = EXCLUDED.issue_identifier,
        issue_title = EXCLUDED.issue_title,
        selected_text = CASE
          WHEN EXCLUDED.selected_text <> '' THEN EXCLUDED.selected_text
          ELSE document_issue_links.selected_text
        END
      RETURNING id, doc_id, issue_id, issue_identifier, issue_title, selected_text, created_at
    `,
    [
      link.id,
      link.docId,
      link.issueId,
      link.issueIdentifier,
      link.issueTitle,
      link.selectedText,
      link.createdAt,
    ]
  )

  await touchDoc(input.docId)
  return toDocumentIssueLink(result.rows[0])
}

export async function listDocIssueLinks(docId: string): Promise<DocumentIssueLink[]> {
  const db = await dbPromise
  const result = await db.query<DocumentIssueLinkRow>(
    `
      SELECT id, doc_id, issue_id, issue_identifier, issue_title, selected_text, created_at
      FROM document_issue_links
      WHERE doc_id = $1
      ORDER BY created_at DESC
    `,
    [docId]
  )
  return result.rows.map(toDocumentIssueLink)
}

export async function listIssueDocLinks(issueId: string, issueIdentifier: string): Promise<DocumentIssueLink[]> {
  const db = await dbPromise
  const result = await db.query<DocumentIssueLinkRow>(
    `
      SELECT
        document_issue_links.id,
        document_issue_links.doc_id,
        documents.title AS doc_title,
        document_issue_links.issue_id,
        document_issue_links.issue_identifier,
        document_issue_links.issue_title,
        document_issue_links.selected_text,
        document_issue_links.created_at
      FROM document_issue_links
      LEFT JOIN documents ON documents.id = document_issue_links.doc_id
      WHERE document_issue_links.issue_id = $1 OR document_issue_links.issue_identifier = $2
      ORDER BY document_issue_links.created_at DESC
    `,
    [issueId, issueIdentifier]
  )
  return result.rows.map(toDocumentIssueLink)
}
