import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { mockDatabaseRecords } from '../data/mock'
import { TableView } from './TableView'

const tableRecords = mockDatabaseRecords.slice(0, 24)

const meta = {
  title: 'Databases/TableView',
  component: TableView,
  tags: ['autodocs'],
  args: {
    records: tableRecords,
    selectedRecordId: tableRecords[0]?.id ?? null,
    onSelectRecord: fn(),
    onUpdateRecord: fn(),
    onCreateRecord: fn(),
  },
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="h-[640px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TableView>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByPlaceholderText('Filter records...')).toBeVisible()
    await expect(canvas.getByText(/24 records/)).toBeVisible()
    await expect(canvas.getByText('ダッシュボードのレスポンシブ対応')).toBeVisible()
  },
}

export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByPlaceholderText('Filter records...'), 'Slack')
    await expect(canvas.getByText('Slack連携の通知機能')).toBeVisible()
    await expect(canvas.queryByText('ダッシュボードのレスポンシブ対応')).not.toBeInTheDocument()
  },
}

export const CreateInline: Story = {
  args: {
    onCreateRecord: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /new record/i }))
    await userEvent.type(canvas.getByPlaceholderText('Record title を入力して Enter...'), 'Storybook database record{Enter}')
    await expect(args.onCreateRecord).toHaveBeenCalledWith({
      title: 'Storybook database record',
    })
  },
}
