import { ydoc, workflowCanvasesMap } from '../yjs/yjsProvider'
import type { PersistedWorkflowCanvasNode, WorkflowCanvas, WorkflowCanvasTemplateId } from './workflowDb'
import type { Edge } from '@xyflow/react'

export const WORKFLOW_CANVAS_LOCAL_ORIGIN = 'photon-workflow-canvas-local'

type WorkflowCanvasListener = () => void
type WorkflowCanvasBroadcastMessage = {
  type: 'workflow-canvas-updated'
  databaseId: string
  canvas: WorkflowCanvas
}

let broadcastChannel: BroadcastChannel | null = null

function getBroadcastChannel() {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) {
    return null
  }

  broadcastChannel ??= new BroadcastChannel('photon-workflow-canvases')
  return broadcastChannel
}

function parseWorkflowCanvas(value: string | undefined): WorkflowCanvas | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as Partial<WorkflowCanvas>
    if (
      typeof parsed.databaseId !== 'string' ||
      typeof parsed.selectedTemplateId !== 'string' ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges)
    ) {
      return null
    }

    return {
      databaseId: parsed.databaseId,
      selectedTemplateId:
        parsed.selectedTemplateId === 'kpi-tree' ? 'kpi-tree' : 'business-flow',
      nodes: parsed.nodes as PersistedWorkflowCanvasNode[],
      edges: parsed.edges as Edge[],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function getSyncedWorkflowCanvas(databaseId: string): WorkflowCanvas | null {
  return parseWorkflowCanvas(workflowCanvasesMap.get(databaseId))
}

export function saveSyncedWorkflowCanvas(input: {
  databaseId: string
  selectedTemplateId: WorkflowCanvasTemplateId
  nodes: PersistedWorkflowCanvasNode[]
  edges: Edge[]
}): WorkflowCanvas {
  const canvas: WorkflowCanvas = {
    ...input,
    updatedAt: new Date().toISOString(),
  }

  ydoc.transact(() => {
    workflowCanvasesMap.set(input.databaseId, JSON.stringify(canvas))
  }, WORKFLOW_CANVAS_LOCAL_ORIGIN)

  getBroadcastChannel()?.postMessage({
    type: 'workflow-canvas-updated',
    databaseId: input.databaseId,
    canvas,
  } satisfies WorkflowCanvasBroadcastMessage)

  return canvas
}

export function subscribeWorkflowCanvases(listener: WorkflowCanvasListener) {
  const observer = (_event: unknown, transaction: { origin: unknown }) => {
    if (transaction.origin === WORKFLOW_CANVAS_LOCAL_ORIGIN) return
    listener()
  }

  workflowCanvasesMap.observe(observer)
  const channel = getBroadcastChannel()
  const broadcastObserver = (event: MessageEvent<WorkflowCanvasBroadcastMessage>) => {
    if (event.data?.type !== 'workflow-canvas-updated') return
    ydoc.transact(() => {
      workflowCanvasesMap.set(event.data.databaseId, JSON.stringify(event.data.canvas))
    }, WORKFLOW_CANVAS_LOCAL_ORIGIN)
    listener()
  }
  channel?.addEventListener('message', broadcastObserver)

  return () => {
    workflowCanvasesMap.unobserve(observer)
    channel?.removeEventListener('message', broadcastObserver)
  }
}
