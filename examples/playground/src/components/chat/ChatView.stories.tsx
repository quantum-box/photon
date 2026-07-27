import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { PhotonProvider } from '@quantum-box/photon-react'
import { createBootingPhotonClient } from '../../lib/photonEngine/bootClient'
import { RecordsProvider } from '../../contexts/RecordsContext'
import { AttachmentsProvider } from '../../lib/attachments/useWorkspaceAttachments'
import { ChatView } from './ChatView'

// Stories render against the booting stub client: deterministic, no WASM or
// PGlite startup. The real client is exercised by unit and E2E tests.
const storyClient = createBootingPhotonClient()

const meta = {
  title: 'Chat/ChatView',
  component: ChatView,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <PhotonProvider client={storyClient}>
        <RecordsProvider>
          <AttachmentsProvider>
            <div className="h-[720px]">
              <Story />
            </div>
          </AttachmentsProvider>
        </RecordsProvider>
      </PhotonProvider>
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
