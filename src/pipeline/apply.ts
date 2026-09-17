import { openContext, getPage, HumanNeededError } from '../hh/browser.js'
import { applyToVacancy } from '../hh/apply.js'
import { routeResume } from '../scoring/resumeRouter.js'
import { RateLimiter, describeLimit } from '../queue/rateLimiter.js'
import { Repo, type VacancyRow } from '../db/repo.js'
import { logger } from '../core/logger.js'
import { pause } from '../hh/browser.js'
import type { Config } from '../config/schema.js'

const log = logger('run')

export interface RunResult {
  planned: number
  applied: number
  dryRun: number
  needsHuman: number
  skipped: number
  failed: number
  stopReason?: string
}

/**
 * Walk stored vacancies and answer them, newest first.
 *
 * Stops on the first sign that continuing would make things worse: an exhausted
 * limit, a captcha, a lost session. Pushing on through any of those is how a
 * temporary block becomes a permanent one (RESEARCH §2.2).
 */
export async function runApplications(cfg: Config, limit?: number): Promise<RunResult> {
  const repo = new Repo()
  const limiter = new RateLimiter(cfg, repo)

  const state = limiter.check()
  log.info(describeLimit(state))
  if (!state.allowed) {
    return { planned: 0, applied: 0, dryRun: 0, needsHuman: 0, skipped: 0, failed: 0, stopReason: state.reason }
  }

  // In a dry run the rolling window is irrelevant — nothing is sent, so nothing is
  // consumed. Cap it anyway so a rehearsal stays a rehearsal.
  const budget = cfg.dryRun ? (limit ?? 5) : Math.min(limiter.budget(), limit ?? Number.MAX_SAFE_INTEGER)
  const candidates = repo.pendingVacancies(budget)

  log.info(`${candidates.length} candidates, budget ${budget}${cfg.dryRun ? ' (DRY RUN — nothing will be sent)' : ''}`)

  const result: RunResult = {
    planned: candidates.length,
    applied: 0,
    dryRun: 0,
    needsHuman: 0,
    skipped: 0,
    failed: 0,
  }
  if (candidates.length === 0) return result

  const runId = repo.startRun(cfg.dryRun ? 'dry_run' : 'apply')
  const ctx = await openContext(cfg)

  try {
    const page = await getPage(ctx)

    for (const v of candidates) {
      if (!cfg.dryRun && !limiter.check().allowed) {
        result.stopReason = 'limit_reached'
        log.warn('limit reached mid-run — stopping')
        break
      }

      const route = routeResume(cfg, { title: v.title, description: v.description })
      log.info(`→ ${v.title.slice(0, 60)}  [${route.resume.id}${route.usedFallback ? ' fallback' : ''}]`)

      // Letters are written ahead of time by `npm run letters`. A vacancy with no
      // letter is still applied to — unless hh demands one, an application without a
      // cover letter beats no application at all.
      const stored = repo.latestLetter(v.id)
      let letter: string | null = null
      if (stored) {
        if (cfg.letter.requireManualApproval && !stored.approved_at) {
          log.info('   letter not approved yet — skipping')
          repo.recordApplication({ vacancyId: v.id, runId, status: 'skipped', errorCode: 'letter_unapproved' })
          result.skipped++
          continue
        }
        letter = stored.text
      }

      let outcome
      try {
        outcome = await applyToVacancy(page, cfg, { url: v.url, resume: route.resume, letter })
      } catch (e) {
        if (e instanceof HumanNeededError) {
          result.stopReason = e.state
          log.error(`stopping: ${e.message}`)
          break
        }
        repo.recordApplication({
          vacancyId: v.id,
          runId,
          status: 'failed',
          errorCode: 'exception',
          errorMessage: (e as Error).message,
        })
        result.failed++
        continue
      }

      recordOutcome(repo, runId, v, outcome, result, stored?.id ?? null)

      if (outcome.status === 'blocked') {
        result.stopReason = 'limit_exceeded'
        log.warn('hh says the limit is exhausted — stopping')
        break
      }

      await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
    }
  } finally {
    repo.finishRun(
      runId,
      {
        planned: result.planned,
        applied: result.applied,
        skipped: result.skipped + result.needsHuman,
        failed: result.failed,
      },
      result.stopReason,
    )
    await ctx.close()
  }

  return result
}

function recordOutcome(
  repo: Repo,
  runId: number,
  v: VacancyRow,
  outcome: Awaited<ReturnType<typeof applyToVacancy>>,
  result: RunResult,
  letterId: number | null,
): void {
  const base = { vacancyId: v.id, runId, letterId }

  switch (outcome.status) {
    case 'applied':
      repo.recordApplication({ ...base, status: 'applied', screenshotPath: outcome.screenshot })
      result.applied++
      break

    case 'dry_run':
      repo.recordApplication({ ...base, status: 'dry_run', screenshotPath: outcome.screenshot })
      result.dryRun++
      break

    case 'needs_human':
      repo.recordApplication({
        ...base,
        status: 'needs_human',
        needsHumanReason: outcome.reason,
        screenshotPath: outcome.screenshot,
      })
      result.needsHuman++
      log.info(`   parked: ${outcome.reason}`)
      break

    case 'skipped':
      repo.recordApplication({ ...base, status: 'skipped', errorCode: outcome.reason })
      result.skipped++
      break

    case 'failed':
      repo.recordApplication({
        ...base,
        status: 'failed',
        errorCode: outcome.errorCode,
        errorMessage: outcome.message,
        screenshotPath: outcome.screenshot,
      })
      result.failed++
      log.warn(`   failed: ${outcome.errorCode} — ${outcome.message}`)
      break

    case 'blocked':
      repo.recordApplication({
        ...base,
        status: 'failed',
        errorCode: outcome.errorCode,
        screenshotPath: outcome.screenshot,
      })
      result.failed++
      break
  }
}

export function printRunResult(r: RunResult): void {
  console.log(`\n  planned      ${r.planned}`)
  if (r.applied) console.log(`  applied      ${r.applied}`)
  if (r.dryRun) console.log(`  dry run      ${r.dryRun}  (ready to send, nothing submitted)`)
  if (r.needsHuman) console.log(`  parked       ${r.needsHuman}  → npm run review`)
  if (r.skipped) console.log(`  skipped      ${r.skipped}`)
  if (r.failed) console.log(`  failed       ${r.failed}`)
  if (r.stopReason) console.log(`\n  stopped: ${r.stopReason}`)
  console.log()
}
