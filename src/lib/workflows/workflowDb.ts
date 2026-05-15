import { PGlite } from '@electric-sql/pglite'
import type { Edge, XYPosition } from '@xyflow/react'
import { appKitConfig } from '../../app/kitConfig'
import type { Priority, Status } from '../../data/mock'

export type WorkflowCanvasTemplateId = 'business-flow' | 'kpi-tree'

export interface PersistedWorkflowCanvasNode {
  id: string
  recordId: string
  templateId: WorkflowCanvasTemplateId
  position: XYPosition
  recordSnapshot?: {
    id: string
    identifier: string
    title: string
    description: string
    status: Status
    priority: Priority
  }
}

export interface WorkflowCanvas {
  databaseId: string
  selectedTemplateId: WorkflowCanvasTemplateId
  nodes: PersistedWorkflowCanvasNode[]
  edges: Edge[]
  updatedAt: string
}

interface WorkflowCanvasRow {
  database_id: string
  selected_template_id: string
  nodes_json: string
  edges_json: string
  updated_at: string
}

const dbPromise = PGlite.create({
  dataDir: appKitConfig.workflows.pgliteDataDir,
  relaxedDurability: false,
}).then(async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_canvases (
        database_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        selected_template_id TEXT NOT NULL,
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, database_id)
      );

      CREATE INDEX IF NOT EXISTS workflow_canvases_workspace_updated_idx
        ON workflow_canvases (workspace_id, updated_at DESC);
    `)
  return db
})

function isWorkflowTemplateId(value: unknown): value is WorkflowCanvasTemplateId {
  return value === 'business-flow' || value === 'kpi-tree'
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toWorkflowCanvas(row: WorkflowCanvasRow): WorkflowCanvas {
  const selectedTemplateId = isWorkflowTemplateId(row.selected_template_id)
    ? row.selected_template_id
    : 'business-flow'

  return {
    databaseId: row.database_id,
    selectedTemplateId,
    nodes: parseJsonArray<PersistedWorkflowCanvasNode>(row.nodes_json),
    edges: parseJsonArray<Edge>(row.edges_json),
    updatedAt: row.updated_at,
  }
}

export async function getWorkflowCanvas(
  databaseId: string
): Promise<WorkflowCanvas | null> {
  const db = await dbPromise
  const result = await db.query<WorkflowCanvasRow>(
    `
      SELECT database_id, selected_template_id, nodes_json, edges_json, updated_at
      FROM workflow_canvases
      WHERE workspace_id = $1 AND database_id = $2
      LIMIT 1
    `,
    [appKitConfig.workspace.id, databaseId]
  )

  return result.rows[0] ? toWorkflowCanvas(result.rows[0]) : null
}

export async function saveWorkflowCanvas(input: {
  databaseId: string
  selectedTemplateId: WorkflowCanvasTemplateId
  nodes: PersistedWorkflowCanvasNode[]
  edges: Edge[]
}): Promise<WorkflowCanvas> {
  const db = await dbPromise
  const updatedAt = new Date().toISOString()

  const result = await db.query<WorkflowCanvasRow>(
    `
      INSERT INTO workflow_canvases (
        database_id,
        workspace_id,
        selected_template_id,
        nodes_json,
        edges_json,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (workspace_id, database_id)
      DO UPDATE SET
        selected_template_id = EXCLUDED.selected_template_id,
        nodes_json = EXCLUDED.nodes_json,
        edges_json = EXCLUDED.edges_json,
        updated_at = EXCLUDED.updated_at
      RETURNING database_id, selected_template_id, nodes_json, edges_json, updated_at
    `,
    [
      input.databaseId,
      appKitConfig.workspace.id,
      input.selectedTemplateId,
      JSON.stringify(input.nodes),
      JSON.stringify(input.edges),
      updatedAt,
    ]
  )

  return toWorkflowCanvas(result.rows[0])
}
