import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { mockIssues } from '../data/mock'
import { AttachmentsProvider } from '../lib/attachments/useWorkspaceAttachments'
import { DetailPanel } from './DetailPanel'

const editableIssue = {
  ...mockIssues[10],
  title: 'Storybook database record detail',
  description: 'This record exercises editable database detail panel controls.',
}

const meta = {
  title: 'Databases/RecordDetailPanel',
  component: DetailPanel,
  tags: ['autodocs'],
  args: {
    issue: editableIssue,
    onClose: fn(),
    onUpdateIssue: fn(),
    onDeleteIssue: fn(),
  },
  decorators: [
    (Story) => (
      <AttachmentsProvider>
        <div className="h-[720px] max-w-[420px]">
          <Story />
        </div>
      </AttachmentsProvider>
    ),
  ],
} satisfies Meta<typeof DetailPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Editable: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Storybook database record detail')).toBeVisible()
    await expect(canvas.getByText('Attachments')).toBeVisible()
    await expect(canvas.getByText('No attachments yet.')).toBeVisible()

    await userEvent.click(canvas.getByText('In Progress'))
    await userEvent.click(canvas.getByRole('button', { name: /done/i }))
    await expect(args.onUpdateIssue).toHaveBeenCalledWith(editableIssue.id, 'status', 'done')
  },
}

export const ReadOnly: Story = {
  args: {
    onUpdateIssue: undefined,
    onDeleteIssue: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Storybook database record detail')).toBeVisible()
    await expect(canvas.queryByTitle('Delete issue')).not.toBeInTheDocument()
    await expect(canvas.getByText('This record exercises editable database detail panel controls.')).toBeVisible()
  },
}
