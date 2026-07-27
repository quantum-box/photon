import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { DocxViewer } from './DocxViewer'

const invalidDocxFile = new File(
  ['This is plain text, not a zipped docx package.'],
  'broken-document.docx',
  { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
)

const meta = {
  title: 'Files/DocxViewer',
  component: DocxViewer,
  tags: ['autodocs'],
  args: {
    file: invalidDocxFile,
    name: 'broken-document.docx',
  },
  decorators: [
    (Story) => (
      <div className="h-[420px] overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DocxViewer>

export default meta
type Story = StoryObj<typeof meta>

export const ErrorState: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText(/Failed to load document/)).toBeVisible()
  },
}
