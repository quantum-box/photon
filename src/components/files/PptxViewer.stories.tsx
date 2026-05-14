import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { PptxViewer } from './PptxViewer'

const pptxLikeFile = new File(
  [
    '<a:t>Photon Workspace</a:t><a:t>Local-first databases</a:t><a:t>Docs and chat context</a:t>',
    '<a:t>Verification</a:t><a:t>Storybook UI tests</a:t><a:t>Playwright E2E</a:t>',
  ],
  'photon-roadmap.pptx',
  { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
)

const meta = {
  title: 'Files/PptxViewer',
  component: PptxViewer,
  tags: ['autodocs'],
  args: {
    file: pptxLikeFile,
    name: 'photon-roadmap.pptx',
  },
  decorators: [
    (Story) => (
      <div className="h-[460px] overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PptxViewer>

export default meta
type Story = StoryObj<typeof meta>

export const ExtractedText: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('Photon Workspace')).toBeVisible()
    await expect(canvas.getByText('Slide 1 / 2')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }))
    await expect(await canvas.findByText('Verification')).toBeVisible()
  },
}
