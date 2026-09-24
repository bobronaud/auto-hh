export interface LogEvent {
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  msg: string
  data?: unknown
}

export interface LimitState {
  allowed: boolean
  reason?: 'day' | 'hour'
  usedDay: number
  usedHour: number
  remainingDay: number
  remainingHour: number
  nextSlotAt?: string
}

export type RunMode = 'collect' | 'apply' | 'letters' | 'session'

export interface RunState {
  mode: RunMode
  startedAt: string
  limit?: number
}

export interface DashboardState {
  dryRun: boolean
  configPath: string
  warnings: string[]
  hhCeiling: number
  limits: { perDay: number; perHour: number; state: LimitState }
  counts: {
    vacancies: number
    pending: number
    needsHuman: number
    failed: number
    appliedTotal: number
    appliedDay: number
    appliedHour: number
    lettersAwaitingApproval: number
    byStatus: Record<string, number>
  }
  letter: { mode: 'static' | 'llm'; maxChars: number; text: string; requireManualApproval: boolean }
  resumes: Array<{ id: string; title: string; match: string[] }>
  search: { text: string; area: string[]; period: number; maxPages: number }
  session: { hasProfile: boolean; profilePath: string }
  run: RunState | null
  lastRun: { mode: RunMode; startedAt: string; finishedAt: string; ok: boolean; result: unknown } | null
}

export interface VacancyRow {
  id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  area: string | null
  salary_from: number | null
  salary_to: number | null
  salary_currency: string | null
  has_test: number | null
  can_apply_from_list: number | null
  snippet: string | null
  found_at: string
}

/** A queue row plus the letter that will go with it. */
export interface PendingRow extends VacancyRow {
  letter_id: number | null
  letter_text: string | null
  letter_approved_at: string | null
}

export interface NeedsHumanRow {
  application_id: number
  vacancy_id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  needs_human_reason: string | null
  created_at: string
  resolved_at: string | null
}

export interface FailedRow {
  application_id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  error_code: string | null
  error_message: string | null
  screenshot_path: string | null
  created_at: string
}

export interface HistoryRow {
  application_id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  status: string
  error_code: string | null
  error_message: string | null
  needs_human_reason: string | null
  screenshot_path: string | null
  applied_at: string | null
  created_at: string
  resolved_at: string | null
  /** The letter sent with this application. null in static mode — nothing is stored. */
  letter_text: string | null
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body
}

const post = <T,>(url: string, body?: unknown): Promise<T> =>
  json<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

export const api = {
  state: () => json<DashboardState>('/api/state'),
  pending: (limit = 100, offset = 0) =>
    json<{ total: number; rows: PendingRow[] }>(`/api/queue/pending?limit=${limit}&offset=${offset}`),
  needsHuman: (includeResolved = false) =>
    json<{ rows: NeedsHumanRow[] }>(`/api/queue/needs-human?includeResolved=${includeResolved}`),
  failed: () =>
    json<{ rows: FailedRow[]; breakdown: Array<{ error_code: string; n: number }> }>('/api/queue/failed'),
  history: (status = 'all', limit = 200) =>
    json<{ rows: HistoryRow[] }>(`/api/history?status=${status}&limit=${limit}`),
  config: () =>
    json<{ path: string; raw: string | null; warnings: string[]; config: unknown }>('/api/config'),
  resolve: (id: number) => post<{ ok: true }>(`/api/needs-human/${id}/resolve`),
  resolveAll: () => post<{ ok: true; resolved: number }>('/api/needs-human/resolve-all'),
  approveLetter: (id: number, text?: string) =>
    post<{ ok: true; id: number }>(`/api/letters/${id}/approve`, text === undefined ? {} : { text }),
  requeueOne: (id: number) => post<{ ok: true; id: number }>(`/api/failed/${id}/requeue`),
  markApplied: (id: number) => post<{ ok: true; id: number }>(`/api/failed/${id}/mark-applied`),
  requeue: (errorCode?: string) => post<{ requeued: number }>('/api/failed/requeue', { errorCode }),
  run: (mode: RunMode, limit?: number) => post<{ run: RunState }>(`/api/run/${mode}`, { limit }),
  setDryRun: (dryRun: boolean) => post<{ dryRun: boolean }>('/api/config/dry-run', { dryRun }),
  setSearchText: (text: string) => post<{ text: string }>('/api/config/search-text', { text }),
  setLetter: (patch: { mode?: 'static' | 'llm'; text?: string }) =>
    post<{ mode?: string; text?: string }>('/api/config/letter', patch),
}

/** Screenshots are stored as absolute paths; the server only serves by file name. */
export const screenshotUrl = (path: string): string =>
  `/api/screenshot/${encodeURIComponent(path.split('/').pop() ?? '')}`
