export type DocBlockType =
  | 'paragraph'
  | 'heading'
  | 'checklist'
  | 'code'
  | 'quote'
  | 'divider'
  | 'table'

export interface DocMetadata {
  id: string
  title: string
  workspaceId: string
  createdAt: string
  updatedAt: string
}

export interface DocumentRecordLink {
  id: string
  docId: string
  docTitle?: string
  recordId: string
  recordIdentifier: string
  recordTitle: string
  selectedText: string
  createdAt: string
}

export interface DocBlock {
  id: string
  type: DocBlockType
  text: string
  checked: boolean
  language: string
}

export interface CreateDocInput {
  id?: string
  title?: string
}

export interface UpdateDocInput {
  title?: string
}

export interface LinkDocRecordInput {
  docId: string
  recordId: string
  recordIdentifier: string
  recordTitle: string
  selectedText?: string
}
