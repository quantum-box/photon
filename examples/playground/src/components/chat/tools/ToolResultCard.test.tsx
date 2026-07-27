import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolResultCard } from './ToolResultCard'
import type { ToolCall } from './types'

const completedRecordTool: ToolCall = {
  id: 'tool-1',
  type: 'record_move',
  name: 'Move DatabaseRecord',
  args: {},
  status: 'completed',
  result: {
    duration: 420,
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
          createdAt: '2026-05-14T02:00:00.000Z',
          updatedAt: '2026-05-14T02:01:00.000Z',
          description: '',
        },
      ],
    },
  },
}

describe('ToolResultCard', () => {
  it('renders completed record tool results with status and priority metadata', () => {
    render(<ToolResultCard toolCall={completedRecordTool} />)

    expect(screen.getByText('Move DatabaseRecord')).toBeInTheDocument()
    expect(screen.getByText(/Moved PLT-108/)).toBeInTheDocument()
    expect(screen.getByText('PLT-108')).toBeInTheDocument()
    expect(screen.getByText('Chat touch record')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('─ None')).toBeInTheDocument()
  })

  it('renders an empty search result state', () => {
    render(
      <ToolResultCard
        toolCall={{
          id: 'tool-2',
          type: 'record_search',
          name: 'DatabaseRecord Search',
          args: {},
          status: 'completed',
          result: {
            data: {
              action: 'search',
              total: 0,
              message: '0 records matched',
              records: [],
            },
          },
        }}
      />
    )

    expect(screen.getByText('DatabaseRecord Search')).toBeInTheDocument()
    expect(screen.getByText('No matching records.')).toBeInTheDocument()
  })

  it('renders a loading state while record tools are running', () => {
    render(
      <ToolResultCard
        toolCall={{
          id: 'tool-3',
          type: 'record_create',
          name: 'Create DatabaseRecord',
          args: {},
          status: 'running',
        }}
      />
    )

    expect(screen.getByText('Create DatabaseRecord')).toBeInTheDocument()
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
              endpoint: '/api/records',
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
