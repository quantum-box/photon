import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessage } from './ChatMessage'
import type { Message } from './ChatMessage'
import { ThemeProvider } from '../../contexts/ThemeContext'

const timestamp = new Date('2026-05-14T11:00:00+09:00').getTime()

describe('ChatMessage', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function renderMessage(message: Message) {
    return render(
      <ThemeProvider>
        <ChatMessage message={message} />
      </ThemeProvider>
    )
  }

  it('renders a user message with attachments and opens previews from chips', () => {
    const onPreviewFile = vi.fn()
    const message: Message = {
      id: 'msg-1',
      role: 'user',
      content: 'Please review this file.',
      timestamp,
      attachments: [
        {
          id: 'attachment-1',
          name: 'workspace-brief.pdf',
          size: 2048,
          type: 'application/pdf',
        },
      ],
    }

    render(
      <ThemeProvider>
        <ChatMessage message={message} onPreviewFile={onPreviewFile} />
      </ThemeProvider>
    )

    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Please review this file.')).toBeInTheDocument()

    fireEvent.click(screen.getByText('workspace-brief.pdf'))

    expect(onPreviewFile).toHaveBeenCalledWith(message.attachments?.[0])
  })

  it('copies assistant message content from the action button', () => {
    const message: Message = {
      id: 'msg-2',
      role: 'assistant',
      content: 'Done. I updated the workspace record data.',
      timestamp,
    }

    renderMessage(message)

    fireEvent.click(screen.getByTitle('Copy message'))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Done. I updated the workspace record data.'
    )
  })

  it('renders record tool result cards before assistant text', () => {
    const message: Message = {
      id: 'msg-3',
      role: 'assistant',
      content: 'The record was moved.',
      timestamp,
      toolCalls: [
        {
          id: 'tool-1',
          type: 'record_move',
          name: 'Move Record',
          args: {},
          status: 'completed',
          result: {
            duration: 240,
            data: {
              action: 'move',
              total: 1,
              message: 'Moved PLT-108',
              records: [
                {
                  id: 'record-108',
                  identifier: 'PLT-108',
                  title: 'Chat touch record',
                  status: 'done',
                  priority: 'none',
                  assignee: null,
                  labels: ['workspace'],
                  project: 'Client App Kit',
                  createdAt: new Date(timestamp).toISOString(),
                  updatedAt: new Date(timestamp).toISOString(),
                  description: '',
                },
              ],
            },
          },
        },
      ],
    }

    renderMessage(message)

    expect(screen.getByText('Move Record')).toBeInTheDocument()
    expect(screen.getByText('PLT-108')).toBeInTheDocument()
    expect(screen.getByText('Chat touch record')).toBeInTheDocument()
    expect(screen.getByText('The record was moved.')).toBeInTheDocument()
  })
})
