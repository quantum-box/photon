import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { ChatMessage } from './ChatMessage'
import type { Message } from './ChatMessage'

const baseTime = new Date('2026-05-14T11:00:00+09:00').getTime()

const assistantToolMessage: Message = {
  id: 'assistant-tool',
  role: 'assistant',
  content: 'Done. I updated the workspace database record through the server-backed store.',
  timestamp: baseTime,
  toolCalls: [
    {
      id: 'tool-1',
      type: 'record_move',
      name: 'Move Record',
      args: {},
      status: 'completed',
      result: {
        duration: 420,
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
              createdAt: new Date(baseTime).toISOString(),
              updatedAt: new Date(baseTime).toISOString(),
              description: '',
            },
          ],
        },
      },
    },
  ],
}

const meta = {
  title: 'Chat/ChatMessage',
  component: ChatMessage,
  tags: ['autodocs'],
  args: {
    onPreviewFile: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof ChatMessage>

export default meta
type Story = StoryObj<typeof meta>

export const UserWithAttachment: Story = {
  args: {
    message: {
      id: 'user-attachment',
      role: 'user',
      content: 'Please review this workspace brief.',
      timestamp: baseTime,
      attachments: [
        {
          id: 'attachment-1',
          name: 'workspace-brief.pdf',
          size: 482_900,
          type: 'application/pdf',
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Please review this workspace brief.')).toBeVisible()
    await expect(canvas.getByText('workspace-brief.pdf')).toBeVisible()
  },
}

export const AssistantWithDatabaseTool: Story = {
  args: {
    message: assistantToolMessage,
    isLastAssistant: true,
    onRegenerate: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/updated the workspace database record/i)).toBeVisible()
    await expect(canvas.getByText('Move Record')).toBeVisible()
    await expect(canvas.getByText('PLT-108')).toBeVisible()
  },
}
