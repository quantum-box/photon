import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { mockIssues } from '../../data/mock'
import type { DocMetadata } from '../../lib/docs/types'
import type { FileAttachment } from '../files/types'
import { DocumentEditor, DocumentTitleInput } from './DocsView'

const now = new Date('2026-05-14T09:00:00.000Z').toISOString()

const doc: DocMetadata = {
  id: 'storybook-doc-editor',
  title: 'Customer research notes',
  workspaceId: 'workspace-storybook',
  createdAt: now,
  updatedAt: now,
}

const attachments: FileAttachment[] = [
  {
    id: 'attachment-1',
    name: 'research-summary.pdf',
    type: 'application/pdf',
    size: 128_000,
    url: 'https://example.com/research-summary.pdf',
    previewType: 'pdf',
  },
]

const meta = {
  title: 'Docs/Editor',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="h-[680px] bg-canvas">
        <Story />
      </div>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const TitleInput: Story = {
  parameters: {
    layout: 'centered',
  },
  render: () => (
    <div className="w-[520px] rounded border border-border bg-panel p-4">
      <DocumentTitleInput doc={doc} onRename={fn()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByLabelText('Document title')
    await expect(input).toHaveValue('Customer research notes')
    await userEvent.clear(input)
    await userEvent.type(input, 'Renewal planning notes')
    await expect(input).toHaveValue('Renewal planning notes')
  },
}

export const DocumentEditorWorkspace: Story = {
  render: () => (
    <DocumentEditor
      doc={doc}
      issues={mockIssues.slice(0, 8)}
      links={[]}
      onIssueLinked={async () => undefined}
      onCreateIssueFromSelection={async () => null}
      onRename={fn()}
      attachments={attachments}
      onAttachFiles={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText('Document title')).toHaveValue('Customer research notes')
    await expect(canvas.getByLabelText('Link record to document')).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Create record from selection' })).toBeDisabled()
    await expect(canvas.getByText('research-summary.pdf')).toBeVisible()
    await waitFor(
      async () => {
        await expect(canvas.queryByText('Loading document...')).not.toBeInTheDocument()
      },
      { timeout: 2500 }
    )
  },
}

export const DocumentEditorEmptyRelations: Story = {
  render: () => (
    <DocumentEditor
      doc={{
        ...doc,
        id: 'storybook-doc-empty-relations',
        title: 'Draft product spec',
      }}
      issues={mockIssues.slice(0, 3)}
      links={[]}
      onIssueLinked={async () => undefined}
      onCreateIssueFromSelection={async () => null}
      onRename={fn()}
      attachments={[]}
      onAttachFiles={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText('Document title')).toHaveValue('Draft product spec')
    await expect(canvas.getByText('PGlite metadata')).toBeVisible()
    await expect(canvas.getByText('Yjs blocks')).toBeVisible()
    await expect(canvas.queryByTestId('doc-related-issues')).not.toBeInTheDocument()
    await expect(canvas.queryByTestId('doc-attachments')).not.toBeInTheDocument()
  },
}
