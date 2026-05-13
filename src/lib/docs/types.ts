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

export interface DocumentIssueLink {
  id: string
  docId: string
  docTitle?: string
  issueId: string
  issueIdentifier: string
  issueTitle: string
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

export interface LinkDocIssueInput {
  docId: string
  issueId: string
  issueIdentifier: string
  issueTitle: string
  selectedText?: string
}
