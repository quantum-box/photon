import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { PdfViewer } from './PdfViewer'

const meta = {
  title: 'Files/PdfViewer',
  component: PdfViewer,
  tags: ['autodocs'],
  args: {
    url: 'data:application/pdf;base64,broken',
    name: 'broken-preview.pdf',
  },
  decorators: [
    (Story) => (
      <div className="h-[420px] overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PdfViewer>

export default meta
type Story = StoryObj<typeof meta>

export const LoadingToolbar: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('broken-preview.pdf')).toBeVisible()
    await expect(canvas.getByText(/120\s*%/)).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Prev' })).toBeDisabled()
    await expect(canvas.getByRole('button', { name: 'Next' })).toBeDisabled()
  },
}
