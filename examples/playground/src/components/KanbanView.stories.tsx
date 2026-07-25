import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { mockDatabaseRecords } from '../data/mock'
import { KanbanView } from './KanbanView'

const boardRecords = mockDatabaseRecords.slice(0, 15)

const meta = {
  title: 'Databases/BoardView',
  component: KanbanView,
  tags: ['autodocs'],
  args: {
    records: boardRecords,
    selectedRecordId: boardRecords[2]?.id ?? null,
    onSelectRecord: fn(),
    onMoveRecord: fn(),
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
} satisfies Meta<typeof KanbanView>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/15 records/)).toBeVisible()
    await expect(canvas.getByText('Backlog')).toBeVisible()
    await expect(canvas.getByText('Todo')).toBeVisible()
    await expect(canvas.getByText('カンバンビューのドラッグ&ドロップ実装')).toBeVisible()
  },
}

export const Compact: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Default' }))
    await expect(canvas.getByRole('button', { name: 'Compact' })).toBeVisible()
    await expect(canvas.getByText('カンバンビューのドラッグ&ドロップ実装')).toBeVisible()
  },
}
