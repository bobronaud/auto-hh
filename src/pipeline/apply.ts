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

  // In llm mode the letters are written here, at the head of the run, for exactly the
  // vacancies this run is about to answer. One button, not two: a letter is part of
  // the application, and a separate step that has to be remembered first is a step
  // that gets forgotten — with the application going out bare.
  //
  // Still a batch rather than a letter per vacancy inside the loop: every claude-cli
  // call re-sends Claude Code's system prompt, which measured 24x per letter. The hh
  // traffic is unchanged either way — the vacancy pages are read once for their
  // descriptions, exactly as the standalone letters run read them.
  if (cfg.letter.mode === 'llm') {
    const needLetters = candidates.filter((v) => !repo.latestLetter(v.id))
    if (needLetters.length > 0) {
      log.info(`writing ${needLetters.length} letters before applying`)
      const { writeLettersFor } = await import('./letters.js')
      const written = await writeLettersFor(cfg, needLetters)
      log.info(`letters: ${written.written} written, ${written.rejected} rejected`)
      // A captcha or a lost session during the reading stops the run: the apply loop
      // would walk into the same wall, one page later.
      if (written.stopReason) {
        result.stopReason = written.stopReason
        return result
      }
    }
  }

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

      // Static mode needs nothing prepared: the same text goes with every
      // application, so there is no generation step and nothing to approve.
      let letter: string | null = null
      let stored: { id: number; text: string; approved_at: string | null } | undefined

      if (cfg.letter.mode === 'static') {
        letter = cfg.letter.text.trim() || null
      } else {
        // The letter was written at the head of this run (or by `npm run letters`
        // earlier). If it is still missing, generation failed or validation rejected
        // it — the vacancy is passed over and stays in the queue for the next run
        // rather than going out bare. Nothing is written to `applications`: a row of
        // any status drops the vacancy from the queue for good.
        stored = repo.latestLetter(v.id)
        if (!stored) {
          log.warn('   no letter — leaving it in the queue')
          result.skipped++
          continue
        }
        if (cfg.letter.requireManualApproval && !stored.approved_at) {
          // Same reasoning, same handling: waiting for approval is a pass, not a
          // verdict, so the vacancy keeps its place in the queue.
          log.info('   letter not approved yet — leaving it in the queue')
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
