import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { MarkdownRenderer } from './MarkdownRenderer'

const meta = {
  title: 'Chat/MarkdownRenderer',
  component: MarkdownRenderer,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-lg border border-border bg-surface p-5">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkdownRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const RichResponse: Story = {
  args: {
    content: [
      '## Workspace summary',
      '',
      'Photon is a **local-first** workspace with Notion-like databases, docs, chat, and file preview support.',
      '',
      '- Database record updates sync through Yjs',
      '- Docs keep local metadata in PGlite',
      '- Chat tools can reference workspace state',
      '',
      '| Area | Status |',
      '| --- | --- |',
      '| Storybook | Ready |',
      '| E2E | Covered |',
      '',
      '> Keep the UI compact enough for daily operations.',
      '',
      '```ts',
      'const status = "ready"',
      '```',
    ].join('\n'),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'Workspace summary' })).toBeVisible()
    await expect(canvas.getByText('local-first')).toBeVisible()
    await expect(canvas.getByText('Storybook')).toBeVisible()
    await expect(canvas.getByText('ts')).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Copy' })).toBeVisible()
  },
}

export const InlineCodeAndLinks: Story = {
  args: {
    content: 'Use `npm run test-storybook` before opening the [local Storybook](http://127.0.0.1:6006/).',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('npm run test-storybook')).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'local Storybook' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:6006/'
    )
  },
}
