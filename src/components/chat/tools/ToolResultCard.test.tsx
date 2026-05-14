import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolResultCard } from './ToolResultCard'
import type { ToolCall } from './types'

const completedIssueTool: ToolCall = {
  id: 'tool-1',
  type: 'issue_move',
  name: 'Move Issue',
  args: {},
  status: 'completed',
  result: {
    duration: 420,
    data: {
      action: 'move',
      total: 1,
      message: 'Moved PLT-108',
      issues: [
        {
          id: 'issue-108',
          identifier: 'PLT-108',
          title: 'Chat touch issue',
          status: 'done',
          priority: 'none',
          assignee: null,
          labels: ['workspace'],
          project: 'Client App Kit',
          createdAt: '2026-05-14T02:00:00.000Z',
          updatedAt: '2026-05-14T02:01:00.000Z',
          description: '',
        },
      ],
    },
  },
}

describe('ToolResultCard', () => {
  it('renders completed issue tool results with status and priority metadata', () => {
    render(<ToolResultCard toolCall={completedIssueTool} />)

    expect(screen.getByText('Move Issue')).toBeInTheDocument()
    expect(screen.getByText(/Moved PLT-108/)).toBeInTheDocument()
    expect(screen.getByText('PLT-108')).toBeInTheDocument()
    expect(screen.getByText('Chat touch issue')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('─ None')).toBeInTheDocument()
  })

  it('renders an empty search result state', () => {
    render(
      <ToolResultCard
        toolCall={{
          id: 'tool-2',
          type: 'issue_search',
          name: 'Issue Search',
          args: {},
          status: 'completed',
          result: {
            data: {
              action: 'search',
              total: 0,
              message: '0 issues matched',
              issues: [],
            },
          },
        }}
      />
    )

    expect(screen.getByText('Issue Search')).toBeInTheDocument()
    expect(screen.getByText('No matching records.')).toBeInTheDocument()
  })

  it('renders a loading state while issue tools are running', () => {
    render(
      <ToolResultCard
        toolCall={{
          id: 'tool-3',
          type: 'issue_create',
          name: 'Create Issue',
          args: {},
          status: 'running',
        }}
      />
    )

    expect(screen.getByText('Create Issue')).toBeInTheDocument()
    expect(screen.getByText('Reading the database record store...')).toBeInTheDocument()
    expect(screen.getByText('Updating...')).toBeInTheDocument()
  })

  it('expands API call responses on click', () => {
    render(
      <ToolResultCard
        toolCall={{
          id: 'tool-4',
          type: 'api_call',
          name: 'API Call',
          args: {},
          status: 'completed',
          result: {
            data: {
              method: 'GET',
              endpoint: '/api/issues',
              statusCode: 200,
              body: { ok: true },
            },
          },
        }}
      />
    )

    const trigger = screen.getByText('API Call').closest('button')
    expect(trigger).toBeTruthy()
    fireEvent.click(trigger!)

    expect(screen.getByText(/"ok": true/)).toBeInTheDocument()
  })
})
