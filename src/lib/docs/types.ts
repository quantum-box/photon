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
