import { describe, expect, it } from 'vitest'
import { appKitConfig } from '../app/kitConfig'
import { toRecord, type ServerRecord } from './recordsApi'

describe('recordsApi', () => {
  it('normalizes server record projections for the engine read path', () => {
    const serverRecord: ServerRecord = {
      id: 'f3cc94d8-cc78-4fd3-a407-4793ea2f537c',
      identifier: 'PLT-1200',
      title: 'Persist record writes',
      description: 'Route frontend writes through the server.',
      status: 'in_progress',
      priority: 'high',
      assignee: '',
      labels: ['Feature', 'sync'],
      project: 'Photon Core',
      created_at: '2026-05-08 03:30:00',
      updated_at: '2026-05-08 03:31:00',
    }

    expect(toRecord(serverRecord)).toEqual({
      id: 'f3cc94d8-cc78-4fd3-a407-4793ea2f537c',
      identifier: 'PLT-1200',
      title: 'Persist record writes',
      description: 'Route frontend writes through the server.',
      status: 'in_progress',
      priority: 'high',
      assignee: null,
      labels: ['Feature', 'sync'],
      project: 'Photon Core',
      createdAt: '2026-05-08 03:30:00',
      updatedAt: '2026-05-08 03:31:00',
    })
  })

  it('keeps older server rows renderable during migration', () => {
    expect(
      toRecord({
        id: 'legacy-record',
        title: 'Legacy row',
        labels: '["legacy"]',
      })
    ).toMatchObject({
      id: 'legacy-record',
      identifier: 'legacy-record',
      status: 'backlog',
      priority: 'none',
      labels: ['legacy'],
      project: appKitConfig.records.defaultProject,
    })
  })
})
