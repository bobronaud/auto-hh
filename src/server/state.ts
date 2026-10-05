import { existsSync, readdirSync } from 'node:fs'
import { loadConfig, configSource } from '../config/load.js'
import { limitWarnings, HH_DAILY_CEILING } from '../config/schema.js'
import { RateLimiter, type LimitState } from '../queue/rateLimiter.js'
import { Repo } from '../db/repo.js'
import { BROWSER_PROFILE_DIR, projectPath } from '../core/paths.js'
import { currentRun, lastRun, type RunOutcome, type RunState } from './runner.js'

export interface DashboardState {
  dryRun: boolean
  configPath: string
  warnings: string[]
  hhCeiling: number
  limits: {
    perDay: number
    perHour: number
    state: LimitState
  }
  counts: {
    vacancies: number
    pending: number
    needsHuman: number
    /** Chats left to the owner: unanswerable, a live recruiter, or an unconfirmed send. */
    chatsNeedingHuman: number
    failed: number
    appliedTotal: number
    appliedDay: number
    appliedHour: number
    byStatus: Record<string, number>
  }
  letter: { mode: 'static' | 'llm'; maxChars: number; text: string; requireManualApproval: boolean }
  resumes: Array<{ id: string; title: string; match: string[] }>
  search: { text: string; area: string[]; period: number; maxPages: number }
  session: { hasProfile: boolean; profilePath: string }
  run: RunState | null
  lastRun: RunOutcome | null
}

/**
 * Everything the dashboard shows, in one request.
 *
 * Reads only the database and the config file — never hh. A dashboard that pinged hh
 * on every poll would generate more traffic idle than the applications themselves,
 * which is the opposite of what the pacing is for. The session check is an explicit
 * button instead.
 */
export function dashboardState(): DashboardState {
  const cfg = loadConfig(true)
  const repo = new Repo()
  const byStatus = repo.countApplicationsByStatus()

  return {
    dryRun: cfg.dryRun,
    configPath: projectPath(configSource()),
    warnings: limitWarnings(cfg),
    hhCeiling: HH_DAILY_CEILING,
    limits: {
      perDay: cfg.limits.perDay,
      perHour: cfg.limits.perHour,
      state: new RateLimiter(cfg, repo).check(),
    },
    counts: {
      vacancies: repo.countVacancies(),
      pending: repo.countPending(),
      needsHuman: repo.countNeedsHuman(),
      chatsNeedingHuman: repo.countChatsNeedingHuman(),
      failed: repo.countFailed(),
      appliedTotal: byStatus.applied ?? 0,
      appliedDay: repo.countAppliedWithin(24),
      appliedHour: repo.countAppliedWithin(1),
      byStatus,
    },
    letter: {
      mode: cfg.letter.mode,
      maxChars: cfg.letter.maxChars,
      text: cfg.letter.text,
      requireManualApproval: cfg.letter.requireManualApproval,
    },
    resumes: cfg.resumes.map((r) => ({ id: r.id, title: r.title, match: r.match })),
    search: {
      text: cfg.search.text,
      area: cfg.search.area,
      period: cfg.search.period,
      maxPages: cfg.search.maxPages,
    },
    session: {
      hasProfile: existsSync(BROWSER_PROFILE_DIR) && readdirSync(BROWSER_PROFILE_DIR).length > 0,
      profilePath: projectPath(BROWSER_PROFILE_DIR),
    },
    run: currentRun(),
    lastRun: lastRun(),
  }
}
