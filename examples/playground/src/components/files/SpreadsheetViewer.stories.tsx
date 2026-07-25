import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { SpreadsheetViewer } from './SpreadsheetViewer'

const csvFile = new File(
  ['Name,Owner,Status\nStorybook,Aya,Ready\nE2E,Ren,Covered\nDocs,Mina,Local only\n'],
  'workspace-status.csv',
  { type: 'text/csv' }
)

const meta = {
  title: 'Files/SpreadsheetViewer',
  component: SpreadsheetViewer,
  tags: ['autodocs'],
  args: {
    file: csvFile,
    name: 'workspace-status.csv',
  },
  decorators: [
    (Story) => (
      <div className="h-[420px] overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpreadsheetViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Csv: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('workspace-status.csv')).toBeVisible()
    await expect(await canvas.findByText('Storybook')).toBeVisible()
    await expect(canvas.getByText('Ready')).toBeVisible()
    await expect(canvas.getByText('3 rows')).toBeVisible()
  },
}
