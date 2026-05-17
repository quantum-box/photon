import { DndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { mockDatabaseRecords } from '../data/mock'
import { KanbanCard, KanbanColumn, OverlayCard } from './KanbanView'

const selectedRecord = mockDatabaseRecords[2]
const todoRecords = mockDatabaseRecords.filter((record) => record.status === 'todo').slice(0, 4)

const meta = {
  title: 'Databases/BoardView/Parts',
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const RecordCard: Story = {
  render: () => (
    <div className="w-[280px]">
      <DndContext>
        <SortableContext
          items={[selectedRecord.id]}
          strategy={verticalListSortingStrategy}
        >
          <KanbanCard
            record={selectedRecord}
            isSelected={false}
            onClick={fn()}
          />
        </SortableContext>
      </DndContext>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(selectedRecord.identifier)).toBeVisible()
    await expect(canvas.getByText(selectedRecord.title)).toBeVisible()
    await expect(canvas.getByText(selectedRecord.labels[0])).toBeVisible()
  },
}

export const SelectedRecordCard: Story = {
  render: () => (
    <div className="w-[280px]">
      <DndContext>
        <SortableContext
          items={[selectedRecord.id]}
          strategy={verticalListSortingStrategy}
        >
          <KanbanCard
            record={selectedRecord}
            isSelected
            onClick={fn()}
          />
        </SortableContext>
      </DndContext>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText(selectedRecord.title))
    await expect(canvas.getByText(selectedRecord.identifier)).toBeVisible()
  },
}

export const CompactRecordCard: Story = {
  render: () => (
    <div className="w-[280px]">
      <DndContext>
        <SortableContext
          items={[selectedRecord.id]}
          strategy={verticalListSortingStrategy}
        >
          <KanbanCard
            record={selectedRecord}
            isSelected={false}
            onClick={fn()}
            compact
          />
        </SortableContext>
      </DndContext>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(selectedRecord.title)).toBeVisible()
    await expect(canvas.queryByText(selectedRecord.identifier)).not.toBeInTheDocument()
  },
}

export const StatusColumn: Story = {
  parameters: {
    layout: 'fullscreen',
  },
  render: () => (
    <div className="h-[520px] p-4">
      <DndContext>
        <KanbanColumn
          status="todo"
          records={todoRecords}
          selectedRecordId={todoRecords[0]?.id ?? null}
          onSelectRecord={fn()}
          compact={false}
        />
      </DndContext>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Todo')).toBeVisible()
    await expect(canvas.getByText(String(todoRecords.length))).toBeVisible()
    await expect(canvas.getByText(todoRecords[0].title)).toBeVisible()
  },
}

export const EmptyStatusColumn: Story = {
  parameters: {
    layout: 'fullscreen',
  },
  render: () => (
    <div className="h-[360px] p-4">
      <DndContext>
        <KanbanColumn
          status="in_review"
          records={[]}
          selectedRecordId={null}
          onSelectRecord={fn()}
          compact={false}
        />
      </DndContext>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('In Review')).toBeVisible()
    await expect(canvas.getByText('No records')).toBeVisible()
  },
}

export const DragOverlayCard: Story = {
  render: () => (
    <div className="w-[300px] p-6">
      <OverlayCard record={selectedRecord} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(selectedRecord.identifier)).toBeVisible()
    await expect(canvas.getByText(selectedRecord.title)).toBeVisible()
  },
}
