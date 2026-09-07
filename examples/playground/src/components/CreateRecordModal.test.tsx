import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreateRecordModal } from './CreateRecordModal'

describe('CreateRecordModal', () => {
  it('does not render when closed', () => {
    render(
      <CreateRecordModal
        open={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.queryByTestId('create-record-modal')).not.toBeInTheDocument()
  })

  it('requires a title before creating a record', () => {
    render(
      <CreateRecordModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.getByTestId('create-record-submit')).toBeDisabled()

    fireEvent.change(screen.getByTestId('create-record-title'), {
      target: { value: 'New client shell' },
    })

    expect(screen.getByTestId('create-record-submit')).toBeEnabled()
  })

  it('submits normalized create record data and closes the modal', async () => {
    const onClose = vi.fn()
    const onCreate = vi.fn()

    render(
      <CreateRecordModal
        open
        onClose={onClose}
        onCreate={onCreate}
      />
    )

    fireEvent.change(screen.getByTestId('create-record-title'), {
      target: { value: '  New client shell  ' },
    })
    fireEvent.change(screen.getByTestId('create-record-status'), {
      target: { value: 'in_progress' },
    })
    fireEvent.change(screen.getByTestId('create-record-priority'), {
      target: { value: 'high' },
    })
    fireEvent.change(screen.getByTestId('create-record-assignee'), {
      target: { value: '佐藤健' },
    })
    fireEvent.change(screen.getByTestId('create-record-description'), {
      target: { value: '  Build reusable app foundation.  ' },
    })
    fireEvent.click(screen.getByTestId('create-record-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      title: 'New client shell',
      status: 'in_progress',
      priority: 'high',
      assignee: '佐藤健',
      description: 'Build reusable app foundation.',
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('waits for durable creation before closing', async () => {
    let persisted!: () => void
    const local = new Promise<void>(resolve => { persisted = resolve })
    const onClose = vi.fn()
    render(<CreateRecordModal open onClose={onClose} onCreate={() => local} />)
    fireEvent.change(screen.getByTestId('create-record-title'), { target: { value: 'Offline demo' } })
    fireEvent.click(screen.getByTestId('create-record-submit'))
    expect(onClose).not.toHaveBeenCalled()
    persisted()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('closes from escape and backdrop interactions', () => {
    const onClose = vi.fn()

    render(
      <CreateRecordModal
        open
        onClose={onClose}
        onCreate={vi.fn()}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('create-record-modal'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
