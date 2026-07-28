import type { Status } from '../data/mock'

export interface RecordSearchParams {
  database?: string
  view?: string
  status?: Status
  sort?: string
  desc?: boolean
}

export function validateRecordSearch(search: Record<string, unknown>): RecordSearchParams {
  return {
    database: typeof search.database === 'string' ? search.database : undefined,
    view: typeof search.view === 'string' ? search.view : undefined,
    status: typeof search.status === 'string' ? (search.status as Status) : undefined,
    sort: typeof search.sort === 'string' ? search.sort : undefined,
    desc: search.desc === true || search.desc === 'true' ? true : undefined,
  }
}
