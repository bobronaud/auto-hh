import type { Database } from 'better-sqlite3'
import { getDb } from './index.js'

export interface VacancyInput {
  hhId: string
  title: string
  company?: string | null
  url: string
  area?: string | null
  salaryFrom?: number | null
  salaryTo?: number | null
  salaryCurrency?: string | null
  hasTest?: boolean | null
  responseLetterRequired?: boolean | null
  canApplyFromList?: boolean | null
  archived?: boolean
  snippet?: string | null
  raw?: unknown
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
  response_letter_required: number | null
  can_apply_from_list: number | null
  archived: number
  snippet: string | null
  description: string | null
  found_at: string
  detail_fetched_at: string | null
  dismissed_at: string | null
}

export type ApplicationStatus =
  | 'planned'
  | 'applied'
  | 'skipped'
  | 'failed'
  | 'dry_run'
  | 'needs_human'

export interface FailedRow {
  application_id: number
  vacancy_id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  error_code: string | null
  error_message: string | null
  screenshot_path: string | null
  created_at: string
}

export interface NeedsHumanRow {
  application_id: number
  vacancy_id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  needs_human_reason: string | null
  /** For form_unanswered: which question stopped the form, and why. */
  error_message: string | null
  created_at: string
  resolved_at: string | null
}

export interface HistoryRow {
  application_id: number
  vacancy_id: number
  hh_id: string
  title: string
  company: string | null
  url: string
  status: ApplicationStatus
  error_code: string | null
  error_message: string | null
  needs_human_reason: string | null
  screenshot_path: string | null
  applied_at: string | null
  created_at: string
  resolved_at: string | null
  /** The letter that actually went with this application; null in static mode. */
  letter_text: string | null
  /** Employer-form answers as a JSON array of {question, answer}; null without a form. */
  answers_json: string | null
}

/** A queue row with the letter that is going to be sent with it, if there is one. */
export interface PendingRow extends VacancyRow {
  letter_id: number | null
  letter_text: string | null
  letter_approved_at: string | null
}

export interface RunRow {
  id: number
  mode: string
  started_at: string
  finished_at: string | null
  planned: number
  applied: number
  skipped: number
  failed: number
  stop_reason: string | null
}

const now = () => new Date().toISOString()

/**
 * Which application rows take a vacancy out of the queue: every status except
 * `dry_run`. A dry run sends nothing to hh, so its row is a record of the rehearsal,
 * not of an application (invariant 11) — counting it emptied the live queue of every
 * vacancy that had been rehearsed on, with no way back.
 */
const COUNTS_FOR_QUEUE = `a.status <> 'dry_run'`
const bool = (v: boolean | null | undefined): number | null =>
  v === null || v === undefined ? null : v ? 1 : 0

export class Repo {
  constructor(private readonly db: Database = getDb()) {}

  // ---------------------------------------------------------------- vacancies

  /**
   * Insert or refresh. Existing rows keep found_at and never lose a known flag to a
   * later NULL — a search-card scrape knows less than a detail-page scrape (§1.4).
   */
  upsertVacancy(v: VacancyInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO vacancies (hh_id, title, company, url, area, salary_from, salary_to,
                             salary_currency, has_test, response_letter_required,
                             can_apply_from_list, archived, snippet, raw_json, found_at)
      VALUES (@hh_id, @title, @company, @url, @area, @salary_from, @salary_to,
              @salary_currency, @has_test, @response_letter_required,
              @can_apply_from_list, @archived, @snippet, @raw_json, @found_at)
      ON CONFLICT (hh_id) DO UPDATE SET
        title    = excluded.title,
        company  = COALESCE(excluded.company, vacancies.company),
        url      = excluded.url,
        area     = COALESCE(excluded.area, vacancies.area),
        salary_from     = COALESCE(excluded.salary_from, vacancies.salary_from),
        salary_to       = COALESCE(excluded.salary_to, vacancies.salary_to),
        salary_currency = COALESCE(excluded.salary_currency, vacancies.salary_currency),
        has_test                 = COALESCE(excluded.has_test, vacancies.has_test),
        response_letter_required = COALESCE(excluded.response_letter_required,
                                            vacancies.response_letter_required),
        -- Fresh scrape wins here: the button appearing or disappearing is news.
        can_apply_from_list = COALESCE(excluded.can_apply_from_list,
                                       vacancies.can_apply_from_list),
        archived = excluded.archived,
        snippet  = COALESCE(excluded.snippet, vacancies.snippet)
      RETURNING id
    `)
    const row = stmt.get({
      hh_id: v.hhId,
      title: v.title,
      company: v.company ?? null,
      url: v.url,
      area: v.area ?? null,
      salary_from: v.salaryFrom ?? null,
      salary_to: v.salaryTo ?? null,
      salary_currency: v.salaryCurrency ?? null,
      has_test: bool(v.hasTest),
      response_letter_required: bool(v.responseLetterRequired),
      can_apply_from_list: bool(v.canApplyFromList),
      archived: v.archived ? 1 : 0,
      snippet: v.snippet ?? null,
      raw_json: v.raw ? JSON.stringify(v.raw) : null,
      found_at: now(),
    }) as { id: number }
    return row.id
  }

  /** Record a vacancy the filters dropped, for later analysis. Never queued. */
  recordDropped(v: VacancyInput, reason: string): void {
    const t = now()
    this.db
      .prepare(
        `INSERT INTO dropped_vacancies (hh_id, title, company, url, area, snippet, reason,
                                        first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hh_id) DO UPDATE SET
           title        = excluded.title,
           company      = COALESCE(excluded.company, dropped_vacancies.company),
           url          = excluded.url,
           area         = COALESCE(excluded.area, dropped_vacancies.area),
           snippet      = COALESCE(excluded.snippet, dropped_vacancies.snippet),
           reason       = excluded.reason,
           last_seen_at = excluded.last_seen_at,
           seen_count   = dropped_vacancies.seen_count + 1`,
      )
      .run(v.hhId, v.title, v.company ?? null, v.url, v.area ?? null, v.snippet ?? null, reason, t, t)
  }

  getVacancy(id: number): VacancyRow | undefined {
    return this.db.prepare('SELECT * FROM vacancies WHERE id = ?').get(id) as VacancyRow | undefined
  }

  getVacancyByHhId(hhId: string): VacancyRow | undefined {
    return this.db.prepare('SELECT * FROM vacancies WHERE hh_id = ?').get(hhId) as
      | VacancyRow
      | undefined
  }

  setVacancyDetail(
    id: number,
    patch: { description?: string; hasTest?: boolean | null; responseLetterRequired?: boolean | null },
  ): void {
    this.db
      .prepare(
        `UPDATE vacancies SET
           description = COALESCE(?, description),
           has_test = COALESCE(?, has_test),
           response_letter_required = COALESCE(?, response_letter_required),
           detail_fetched_at = ?
         WHERE id = ?`,
      )
      .run(patch.description ?? null, bool(patch.hasTest), bool(patch.responseLetterRequired), now(), id)
  }

  /**
   * Take one vacancy out of the queue by hand — irrelevant or problematic.
   *
   * A column on the vacancy, not an `applications` row: nothing happened on hh, and a
   * fake application would count as one (invariant 11). Not `archived` either: upsert
   * overwrites that on every collect, while `dismissed_at` is never touched by it, so
   * the vacancy stays out of the queue when the search finds it again. Only a pending
   * vacancy can be dismissed — one with an application is already out of the queue.
   */
  dismissVacancy(id: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE vacancies SET dismissed_at = ?
         WHERE id = ? AND dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = vacancies.id AND ${COUNTS_FOR_QUEUE})`,
      )
      .run(now(), id)
    return res.changes > 0
  }

  /** An archived vacancy drops out of every queue: it cannot be applied to. */
  markArchived(id: number): void {
    this.db.prepare('UPDATE vacancies SET archived = 1, detail_fetched_at = ? WHERE id = ?').run(now(), id)
  }

  // ------------------------------------------------------------- deduplication

  /** True if this vacancy already has a successful application. */
  hasApplied(vacancyId: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM applications WHERE vacancy_id = ? AND status = 'applied' LIMIT 1`)
      .get(vacancyId)
    return row !== undefined
  }

  /** hh_ids already applied to, for bulk filtering a fresh scrape. */
  appliedHhIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT v.hh_id FROM applications a
         JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.status = 'applied'`,
      )
      .all() as { hh_id: string }[]
    return new Set(rows.map((r) => r.hh_id))
  }

  /**
   * Vacancies that have not been answered or ruled out yet, newest first.
   *
   * Excludes anything with an application of any kind except a dry run (see
   * COUNTS_FOR_QUEUE) — 'applied' obviously, but also
   * 'needs_human' (it is waiting for the human, not for another attempt), 'skipped'
   * and 'failed'. A failed vacancy is deliberately not retried automatically: the
   * usual cause is a stale selector, and retrying in a loop against hh is precisely
   * the behaviour that gets an account blocked.
   */
  pendingVacancies(limit = 50): VacancyRow[] {
    return this.db
      .prepare(
        `SELECT v.* FROM vacancies v
         WHERE v.archived = 0
           AND v.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = v.id AND ${COUNTS_FOR_QUEUE})
         ORDER BY
           -- Cards that still offer an apply button first: a missing button usually
           -- means we already answered this one, and finding that out costs a full
           -- navigation. NULL (unknown) sorts with the applyable ones, not last.
           CASE WHEN v.can_apply_from_list = 0 THEN 1 ELSE 0 END,
           CAST(v.hh_id AS INTEGER) DESC
         LIMIT ?`,
      )
      .all(limit) as VacancyRow[]
  }

  /** Would pendingVacancies pick this vacancy up? Same conditions, one row. */
  isQueued(id: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM vacancies v
         WHERE v.id = ?
           AND v.archived = 0
           AND v.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = v.id AND ${COUNTS_FOR_QUEUE})`,
      )
      .get(id)
    return row !== undefined
  }

  /**
   * Vacancies queued for an application that have no letter yet.
   *
   * Same ordering as pendingVacancies so the letters written are the ones that will
   * actually be used next, rather than for vacancies far down the queue.
   */
  vacanciesNeedingLetters(limit = 20): VacancyRow[] {
    return this.db
      .prepare(
        `SELECT v.* FROM vacancies v
         WHERE v.archived = 0
           AND v.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = v.id AND ${COUNTS_FOR_QUEUE})
           AND NOT EXISTS (SELECT 1 FROM letters l WHERE l.vacancy_id = v.id)
         ORDER BY
           CASE WHEN v.can_apply_from_list = 0 THEN 1 ELSE 0 END,
           CAST(v.hh_id AS INTEGER) DESC
         LIMIT ?`,
      )
      .all(limit) as VacancyRow[]
  }

  /** Newest letter for a vacancy, approved or not. */
  latestLetter(vacancyId: number): { id: number; text: string; approved_at: string | null } | undefined {
    return this.db
      .prepare(
        `SELECT id, text, approved_at FROM letters
         WHERE vacancy_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(vacancyId) as { id: number; text: string; approved_at: string | null } | undefined
  }

  countLettersAwaitingApproval(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM letters l
         WHERE l.approved_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = l.vacancy_id AND ${COUNTS_FOR_QUEUE})
           AND NOT EXISTS (SELECT 1 FROM vacancies v WHERE v.id = l.vacancy_id AND v.dismissed_at IS NOT NULL)`,
      )
      .get() as { n: number }
    return row.n
  }

  /** How many vacancies are waiting to be answered. */
  countPending(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM vacancies v
         WHERE v.archived = 0
           AND v.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = v.id AND ${COUNTS_FOR_QUEUE})`,
      )
      .get() as { n: number }
    return row.n
  }

  // -------------------------------------------------------------- rate limits

  /**
   * Applications sent within the last `hours`, counted over a ROLLING window.
   *
   * This is the whole point: hh's 200-per-24h is a sliding window, not a calendar
   * day (RESEARCH §5.1, axisrow/hhru#1142). A midnight-reset counter drifts out of
   * sync with hh and starts eating limit_exceeded errors.
   */
  countAppliedWithin(hours: number): number {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
         WHERE status = 'applied' AND applied_at IS NOT NULL AND applied_at >= ?`,
      )
      .get(since) as { n: number }
    return row.n
  }

  /** Oldest application inside the window — tells the UI when a slot frees up. */
  oldestAppliedWithin(hours: number): string | null {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    const row = this.db
      .prepare(
        `SELECT MIN(applied_at) AS t FROM applications
         WHERE status = 'applied' AND applied_at IS NOT NULL AND applied_at >= ?`,
      )
      .get(since) as { t: string | null }
    return row.t
  }

  // ------------------------------------------------------------------- scores

  saveScore(s: {
    vacancyId: number
    vacancy?: number | null
    cvMatch?: number | null
    overall?: number | null
    weighted: number
    reason?: string | null
    model?: string | null
    promptVersion?: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO scores (vacancy_id, score_vacancy, score_cv_match, score_overall,
                             weighted, reason, model, prompt_version, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vacancy_id) DO UPDATE SET
           score_vacancy = excluded.score_vacancy,
           score_cv_match = excluded.score_cv_match,
           score_overall = excluded.score_overall,
           weighted = excluded.weighted,
           reason = excluded.reason,
           model = excluded.model,
           prompt_version = excluded.prompt_version,
           scored_at = excluded.scored_at`,
      )
      .run(
        s.vacancyId,
        s.vacancy ?? null,
        s.cvMatch ?? null,
        s.overall ?? null,
        s.weighted,
        s.reason ?? null,
        s.model ?? null,
        s.promptVersion ?? null,
        now(),
      )
  }

  /** Vacancies with no score yet — the LLM work queue. */
  unscoredVacancies(limit = 100): VacancyRow[] {
    return this.db
      .prepare(
        `SELECT v.* FROM vacancies v
         LEFT JOIN scores s ON s.vacancy_id = v.id
         WHERE s.vacancy_id IS NULL AND v.archived = 0
         ORDER BY v.found_at DESC LIMIT ?`,
      )
      .all(limit) as VacancyRow[]
  }

  // ------------------------------------------------------------------ letters

  saveLetter(l: {
    vacancyId: number
    text: string
    model?: string | null
    promptVersion?: string | null
  }): number {
    const row = this.db
      .prepare(
        `INSERT INTO letters (vacancy_id, text, chars, model, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(l.vacancyId, l.text, l.text.length, l.model ?? null, l.promptVersion ?? null, now()) as {
      id: number
    }
    return row.id
  }

  approveLetter(letterId: number, text?: string): void {
    if (text !== undefined) {
      this.db
        .prepare('UPDATE letters SET text = ?, chars = ?, edited = 1, approved_at = ? WHERE id = ?')
        .run(text, text.length, now(), letterId)
    } else {
      this.db.prepare('UPDATE letters SET approved_at = ? WHERE id = ?').run(now(), letterId)
    }
  }

  // ------------------------------------------------------------- applications

  /** What went into an employer's form for this application, in form order. */
  recordFormAnswers(
    applicationId: number,
    vacancyId: number,
    answers: ReadonlyArray<{ question: string; kind: string; answer: string }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO form_answers (application_id, vacancy_id, position, question, kind, answer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const at = now()
    this.db.transaction(() => {
      answers.forEach((a, i) => stmt.run(applicationId, vacancyId, i + 1, a.question, a.kind, a.answer, at))
    })()
  }

  recordApplication(a: {
    vacancyId: number
    runId?: number | null
    letterId?: number | null
    status: ApplicationStatus
    errorCode?: string | null
    errorMessage?: string | null
    screenshotPath?: string | null
    needsHumanReason?: string | null
  }): number {
    const row = this.db
      .prepare(
        `INSERT INTO applications (vacancy_id, run_id, letter_id, status, error_code,
                                   error_message, screenshot_path, needs_human_reason,
                                   applied_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        a.vacancyId,
        a.runId ?? null,
        a.letterId ?? null,
        a.status,
        a.errorCode ?? null,
        a.errorMessage ?? null,
        a.screenshotPath ?? null,
        a.needsHumanReason ?? null,
        a.status === 'applied' ? now() : null,
        now(),
      ) as { id: number }
    return row.id
  }

  // ---------------------------------------------------------------- failures

  /**
   * Applications that did not go through. Kept in full — error code, message and
   * screenshot — because the usual cause is a stale selector, and a failure without
   * its screenshot is not diagnosable after the fact.
   */
  failedApplications(limit = 200): FailedRow[] {
    return this.db
      .prepare(
        `SELECT a.id AS application_id, v.id AS vacancy_id, v.hh_id, v.title, v.company,
                v.url, a.error_code, a.error_message, a.screenshot_path, a.created_at
         FROM applications a
         JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.status = 'failed'
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as FailedRow[]
  }

  /** Failure counts by cause — which selector broke, and how widely. */
  failureBreakdown(): Array<{ error_code: string; n: number }> {
    return this.db
      .prepare(
        `SELECT COALESCE(error_code, 'unknown') AS error_code, COUNT(*) AS n
         FROM applications WHERE status = 'failed'
         GROUP BY error_code ORDER BY n DESC`,
      )
      .all() as Array<{ error_code: string; n: number }>
  }

  countFailed(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM applications WHERE status = 'failed'`)
      .get() as { n: number }
    return row.n
  }

  /**
   * Put failed vacancies back in the queue by dropping their failure records.
   *
   * Explicitly manual: automatic retries against hh are what turns a broken selector
   * into a blocked account. This is for after the cause has been fixed.
   */
  requeueFailed(errorCode?: string): number {
    const stmt = errorCode
      ? this.db.prepare(`DELETE FROM applications WHERE status = 'failed' AND error_code = ?`)
      : this.db.prepare(`DELETE FROM applications WHERE status = 'failed'`)
    const info = errorCode ? stmt.run(errorCode) : stmt.run()
    return info.changes
  }

  /** The same for a single failure, from its row in the UI. */
  requeueFailedOne(applicationId: number): boolean {
    const res = this.db
      .prepare(`DELETE FROM applications WHERE id = ? AND status = 'failed'`)
      .run(applicationId)
    return res.changes > 0
  }

  /**
   * Mark one failure as a real application, after checking on hh that it went through
   * (a `no_success_confirmation` whose response is in fact in the hh history).
   *
   * `applied_at` is the attempt time, not now: the 24h window has to match what hh
   * counted, and hh counted it when it was sent. The error fields stay as the record of
   * how the row got here; `resolved_at` stamps the manual confirmation. Refuses when the
   * vacancy already has an applied row — the unique index would anyway.
   */
  markFailedApplied(applicationId: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE applications
         SET status = 'applied', applied_at = created_at, resolved_at = ?
         WHERE id = ? AND status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM applications o
             WHERE o.vacancy_id = applications.vacancy_id AND o.status = 'applied'
           )`,
      )
      .run(now(), applicationId)
    return res.changes > 0
  }

  // ------------------------------------------------------------- needs human

  /**
   * The manual-work queue: vacancies the bot deliberately refused to answer
   * (employer questions, tests, external ATS). Ordered newest first; resolved ones
   * drop out unless asked for.
   */
  needsHuman(opts: { includeResolved?: boolean; limit?: number } = {}): NeedsHumanRow[] {
    const where = opts.includeResolved ? '' : 'AND a.resolved_at IS NULL'
    return this.db
      .prepare(
        `SELECT a.id AS application_id, v.id AS vacancy_id, v.hh_id, v.title, v.company,
                v.url, a.needs_human_reason, a.error_message, a.created_at, a.resolved_at
         FROM applications a
         JOIN vacancies v ON v.id = a.vacancy_id
         WHERE a.status = 'needs_human' ${where}
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(opts.limit ?? 200) as NeedsHumanRow[]
  }

  /** Mark one as handled by hand, so it stops showing up in the queue. */
  resolveNeedsHuman(applicationId: number): void {
    this.db.prepare('UPDATE applications SET resolved_at = ? WHERE id = ?').run(now(), applicationId)
  }

  /**
   * Clear the whole manual queue at once, and say how many rows it touched.
   *
   * Only rows still open are stamped: re-stamping an already resolved one would move
   * its date to today and lose when it was actually handled.
   */
  resolveAllNeedsHuman(): number {
    const res = this.db
      .prepare(
        `UPDATE applications SET resolved_at = ?
         WHERE status = 'needs_human' AND resolved_at IS NULL`,
      )
      .run(now())
    return res.changes
  }

  countNeedsHuman(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM applications WHERE status = 'needs_human' AND resolved_at IS NULL`)
      .get() as { n: number }
    return row.n
  }

  // ------------------------------------------------------------------- history

  /**
   * Every application ever recorded, newest first — the UI history tab.
   *
   * Deliberately not filtered down to 'applied': a dry run, a parked vacancy and a
   * failure are all part of what happened, and the screenshot is what makes any of
   * them checkable after the fact (§7).
   *
   * The letter is joined in rather than fetched per row: in llm mode every application
   * carries a different text, and "what did I actually send this employer" is a
   * question asked while scanning the list. A LEFT JOIN because static mode stores no
   * letter at all — the text lives in the config, not in the row.
   */
  applicationHistory(opts: { limit?: number; status?: ApplicationStatus } = {}): HistoryRow[] {
    const where = opts.status ? 'WHERE a.status = ?' : ''
    const stmt = this.db.prepare(
      `SELECT a.id AS application_id, v.id AS vacancy_id, v.hh_id, v.title, v.company,
              v.url, a.status, a.error_code, a.error_message, a.needs_human_reason,
              a.screenshot_path, a.applied_at, a.created_at, a.resolved_at,
              l.text AS letter_text,
              (SELECT json_group_array(json_object('question', f.question, 'answer', f.answer))
                 FROM (SELECT question, answer FROM form_answers
                        WHERE application_id = a.id ORDER BY position) f
                HAVING COUNT(*) > 0) AS answers_json
       FROM applications a
       JOIN vacancies v ON v.id = a.vacancy_id
       LEFT JOIN letters l ON l.id = a.letter_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    const limit = opts.limit ?? 200
    return (opts.status ? stmt.all(opts.status, limit) : stmt.all(limit)) as HistoryRow[]
  }

  /**
   * One page of the pending queue, in the exact order `pendingVacancies` would hand
   * them to a run — the UI has to show what is actually next, not a prettier sort.
   *
   * The letter comes along because this is the only place it can be read before it is
   * sent: the history tab shows what already went out, which is too late to change
   * anything. Newest letter per vacancy — a regenerated one supersedes its predecessor
   * exactly as `latestLetter` (and therefore the apply run) sees it.
   */
  pendingPage(limit = 50, offset = 0): PendingRow[] {
    return this.db
      .prepare(
        `SELECT v.*, l.id AS letter_id, l.text AS letter_text, l.approved_at AS letter_approved_at
         FROM vacancies v
         LEFT JOIN letters l
           ON l.id = (SELECT id FROM letters WHERE vacancy_id = v.id ORDER BY id DESC LIMIT 1)
         WHERE v.archived = 0
           AND v.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.vacancy_id = v.id AND ${COUNTS_FOR_QUEUE})
         ORDER BY
           CASE WHEN v.can_apply_from_list = 0 THEN 1 ELSE 0 END,
           CAST(v.hh_id AS INTEGER) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as PendingRow[]
  }

  countApplicationsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')
      .all() as Array<{ status: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  /** Total vacancies stored, answered or not — the size of what collect has built. */
  countVacancies(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM vacancies').get() as { n: number }
    return row.n
  }

  recentRuns(limit = 20): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as RunRow[]
  }

  // ---------------------------------------------------------------------- runs

  startRun(mode: string): number {
    const row = this.db
      .prepare('INSERT INTO runs (mode, started_at) VALUES (?, ?) RETURNING id')
      .get(mode, now()) as { id: number }
    return row.id
  }

  finishRun(
    runId: number,
    counts: { planned: number; applied: number; skipped: number; failed: number },
    stopReason?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, planned = ?, applied = ?, skipped = ?,
                         failed = ?, stop_reason = ? WHERE id = ?`,
      )
      .run(now(), counts.planned, counts.applied, counts.skipped, counts.failed, stopReason ?? null, runId)
  }

  // ------------------------------------------------------------------------ kv

  kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now())
  }
}
