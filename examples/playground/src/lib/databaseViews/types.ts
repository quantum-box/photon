import type { Priority, Status } from '../../data/mock'

export type DatabaseViewType = 'table' | 'board' | 'workflow'

export type RecordPropertyKey =
  | 'identifier'
  | 'status'
  | 'priority'
  | 'title'
  | 'assignee'
  | 'labels'
  | 'project'
  | 'updatedAt'

export interface DatabaseViewFilters {
  search: string
  status?: Status
  priority?: Priority
  assignee?: string
  labels: string[]
  project?: string
}

export interface DatabaseViewSorting {
  id: RecordPropertyKey
  desc: boolean
}

export interface DatabaseViewBoardSettings {
  compact: boolean
}

export interface DatabaseViewDefinition {
  id: string
  databaseId: string
  name: string
  type: DatabaseViewType
  filters: DatabaseViewFilters
  sorting: DatabaseViewSorting | null
  visibleProperties: RecordPropertyKey[]
  board: DatabaseViewBoardSettings
  workflowCanvasKey: string
  order: number
  createdAt: string
  updatedAt: string
}
