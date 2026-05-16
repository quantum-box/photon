import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreateIssueModal } from './CreateIssueModal'

describe('CreateIssueModal', () => {
  it('does not render when closed', () => {
    render(
      <CreateIssueModal
        open={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.queryByTestId('create-issue-modal')).not.toBeInTheDocument()
  })

  it('requires a title before creating an issue', () => {
    render(
      <CreateIssueModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.getByTestId('create-issue-submit')).toBeDisabled()

    fireEvent.change(screen.getByTestId('create-issue-title'), {
      target: { value: 'New client shell' },
    })

    expect(screen.getByTestId('create-issue-submit')).toBeEnabled()
  })

  it('submits normalized create issue data and closes the modal', async () => {
    const onClose = vi.fn()
    const onCreate = vi.fn()

    render(
      <CreateIssueModal
        open
        onClose={onClose}
        onCreate={onCreate}
      />
    )

    fireEvent.change(screen.getByTestId('create-issue-title'), {
      target: { value: '  New client shell  ' },
    })
    fireEvent.change(screen.getByTestId('create-issue-status'), {
      target: { value: 'in_progress' },
    })
    fireEvent.change(screen.getByTestId('create-issue-priority'), {
      target: { value: 'high' },
    })
    fireEvent.change(screen.getByTestId('create-issue-assignee'), {
      target: { value: '佐藤健' },
    })
    fireEvent.change(screen.getByTestId('create-issue-description'), {
      target: { value: '  Build reusable app foundation.  ' },
    })
    fireEvent.click(screen.getByTestId('create-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      title: 'New client shell',
      status: 'in_progress',
      priority: 'high',
      assignee: '佐藤健',
      description: 'Build reusable app foundation.',
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('closes from escape and backdrop interactions', () => {
    const onClose = vi.fn()

    render(
      <CreateIssueModal
        open
        onClose={onClose}
        onCreate={vi.fn()}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('create-issue-modal'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
