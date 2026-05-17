import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ToolResultCard } from './ToolResultCard'

const meta = {
  title: 'Chat/ToolResultCard',
  component: ToolResultCard,
  tags: ['autodocs'],
} satisfies Meta<typeof ToolResultCard>

export default meta
type Story = StoryObj<typeof meta>

export const DatabaseRecordMoveCompleted: Story = {
  args: {
    toolCall: {
      id: 'tool-move',
      type: 'record_move',
      name: 'Move Record',
      args: {},
      status: 'completed',
      result: {
        duration: 380,
        data: {
          action: 'move',
          total: 1,
          message: 'Moved PLT-108',
          records: [
            {
              id: 'record-108',
              identifier: 'PLT-108',
              title: 'Chat touch database record',
              status: 'done',
              priority: 'none',
              assignee: null,
              labels: ['workspace'],
              project: 'Client App Kit',
              createdAt: '2026-05-14T02:00:00.000Z',
              updatedAt: '2026-05-14T02:01:00.000Z',
              description: '',
            },
          ],
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Move Record')).toBeVisible()
    await expect(canvas.getByText('PLT-108')).toBeVisible()
    await expect(canvas.getByText('Chat touch database record')).toBeVisible()
    await expect(canvas.getByText('Done')).toBeVisible()
  },
}

export const DatabaseSearchEmpty: Story = {
  args: {
    toolCall: {
      id: 'tool-search-empty',
      type: 'record_search',
      name: 'Database Search',
      args: {},
      status: 'completed',
      result: {
        duration: 120,
        data: {
          action: 'search',
          total: 0,
          message: '0 records matched',
          records: [],
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Database Search')).toBeVisible()
    await expect(canvas.getByText(/0 records matched/)).toBeVisible()
    await expect(canvas.getByText('No matching records.')).toBeVisible()
  },
}

export const Running: Story = {
  args: {
    toolCall: {
      id: 'tool-running',
      type: 'record_create',
      name: 'Create Record',
      args: {},
      status: 'running',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Create Record')).toBeVisible()
    await expect(canvas.getByText('Updating...')).toBeVisible()
    await expect(canvas.getByText('Reading the database record store...')).toBeVisible()
  },
}

export const ApiCallCompleted: Story = {
  args: {
    toolCall: {
      id: 'tool-api',
      type: 'api_call',
      name: 'API Call',
      args: {},
      status: 'completed',
      result: {
        duration: 210,
        data: {
          endpoint: '/api/workspace/health',
          method: 'GET',
          statusCode: 200,
          body: {
            status: 'ok',
            message: 'workspace ok',
          },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('API Call')).toBeVisible()
    await expect(canvas.getByText('200')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: /API Call/ }))
    await expect(canvas.getByText(/workspace ok/)).toBeVisible()
  },
}

export const CodeExecutionFailed: Story = {
  args: {
    toolCall: {
      id: 'tool-code',
      type: 'code_exec',
      name: 'Code Execution',
      args: {},
      status: 'completed',
      result: {
        duration: 160,
        data: {
          code: 'npm test',
          output: 'Expected component to be visible',
          exitCode: 1,
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Code Execution')).toBeVisible()
    await expect(canvas.getByText('exit 1')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: /Code Execution/ }))
    await expect(canvas.getByText('Expected component to be visible')).toBeVisible()
  },
}
