import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { FilePreviewModal } from './FilePreviewModal'

const meta = {
  title: 'Files/FilePreviewModal',
  component: FilePreviewModal,
  tags: ['autodocs'],
  args: {
    onClose: fn(),
  },
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof FilePreviewModal>

export default meta
type Story = StoryObj<typeof meta>

export const MetadataOnlyDocx: Story = {
  args: {
    file: {
      id: 'metadata-docx',
      name: 'workspace-notes.docx',
      size: 214_000,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    onClose: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await expect(page.getByText('workspace-notes.docx')).toBeVisible()
    await expect(page.getByText(/Preview metadata is synced/)).toBeVisible()
    await userEvent.click(page.getByRole('button'))
    await expect(args.onClose).toHaveBeenCalled()
  },
}

export const UnknownFile: Story = {
  args: {
    file: {
      id: 'unknown-archive',
      name: 'debug-artifacts.zip',
      size: 932_000,
      type: 'application/zip',
    },
    onClose: fn(),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await expect(page.getByText('debug-artifacts.zip')).toBeVisible()
    await expect(page.getByText(/Preview metadata is synced/)).toBeVisible()
  },
}
