import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { FileChip } from './FileChip'

const meta = {
  title: 'Files/FileChip',
  component: FileChip,
  tags: ['autodocs'],
  args: {
    onPreview: fn(),
  },
} satisfies Meta<typeof FileChip>

export default meta
type Story = StoryObj<typeof meta>

export const Pdf: Story = {
  args: {
    file: {
      id: 'file-pdf',
      name: 'workspace-brief.pdf',
      size: 482_900,
      type: 'application/pdf',
    },
    onPreview: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('workspace-brief.pdf')).toBeVisible()
    await expect(canvas.getByText(/PDF\s+·\s+471\.6 KB/)).toBeVisible()
    await userEvent.click(canvas.getByText('workspace-brief.pdf'))
    await expect(args.onPreview).toHaveBeenCalledWith(args.file)
  },
}

export const Spreadsheet: Story = {
  args: {
    file: {
      id: 'file-xlsx',
      name: 'release-matrix.xlsx',
      size: 1_204_900,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    onPreview: fn(),
    onRemove: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('release-matrix.xlsx')).toBeVisible()
    await expect(canvas.getByText(/XLSX\s+·\s+1\.1 MB/)).toBeVisible()

    await userEvent.hover(canvas.getByText('release-matrix.xlsx'))
    await userEvent.click(canvas.getByRole('button'))
    await expect(args.onRemove).toHaveBeenCalledWith('file-xlsx')
    await expect(args.onPreview).not.toHaveBeenCalled()
  },
}
