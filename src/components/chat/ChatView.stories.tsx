import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { IssuesProvider } from '../../contexts/IssuesContext'
import { AttachmentsProvider } from '../../lib/attachments/useWorkspaceAttachments'
import { ChatView } from './ChatView'

const meta = {
  title: 'Chat/ChatView',
  component: ChatView,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <IssuesProvider>
        <AttachmentsProvider>
          <div className="h-[720px]">
            <Story />
          </div>
        </AttachmentsProvider>
      </IssuesProvider>
    ),
  ],
} satisfies Meta<typeof ChatView>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Send a message to start a conversation')).toBeVisible()
    await expect(canvas.getByTestId('chat-message-input')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: /web search/i }))
    await expect(canvas.getByTestId('chat-message-input')).toHaveValue('Search for React 19 features')
  },
}
