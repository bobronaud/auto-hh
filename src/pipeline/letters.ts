import { Repo, type VacancyRow } from '../db/repo.js'
import { openContext, getPage, HumanNeededError, pause, randomBetween } from '../hh/browser.js'
import { fetchVacancyDetails } from '../hh/vacancyPage.js'
import { routeResume } from '../scoring/resumeRouter.js'
import { generateLetters } from '../letters/generate.js'
import { PROMPT_VERSION, type LetterTarget } from '../letters/prompt.js'
import { createProvider } from '../llm/provider.js'
import { logger } from '../core/logger.js'
import type { Config, ResumeConfig } from '../config/schema.js'

const log = logger('letters')

export interface LettersResult {
  requested: number
  detailsFetched: number
  written: number
  rejected: number
  byResume: Record<string, number>
  stopReason?: string
}

/**
 * Write letters for the vacancies that are next in line.
 *
 * Grouped by resume and sent in batches, because the per-call overhead dwarfs the
 * payload — see letters/generate.ts. Letters are stored unapproved; nothing here
 * touches hh.
 */
export async function writeLetters(cfg: Config, limit: number): Promise<LettersResult> {
  if (cfg.letter.mode === 'static') {
    throw new Error(
      'letter.mode is "static" — the same text goes with every application, so there is ' +
        'nothing to generate. Set letter.mode to "llm" to write per-vacancy letters.',
    )
  }
  return writeLettersFor(cfg, new Repo().vacanciesNeedingLetters(limit))
}

/**
 * The same work for an exact list of vacancies.
 *
 * This is what an apply run calls: it has already chosen the vacancies it is about to
 * answer, and letters must be written for THOSE, not for whatever the letter queue
 * would have picked on its own. The two lists are ordered the same way but drift apart
 * as soon as some of the vacancies already have a letter.
 */
export async function writeLettersFor(
  cfg: Config,
  pending: readonly VacancyRow[],
): Promise<LettersResult> {
  const repo = new Repo()
  const provider = createProvider(cfg)

  const result: LettersResult = {
    requested: pending.length,
    detailsFetched: 0,
    written: 0,
    rejected: 0,
    byResume: {},
  }
  if (pending.length === 0) return result

  // Read the vacancy pages first. Without a description the letter has nothing to
  // aim at, and — the reason this step exists at all — there is no way to tell that
  // the posting asked for a salary figure or portfolio links.
  const rows = await ensureDescriptions(pending, cfg, repo, result)

  // One batch per resume: a single call must not mix stacks, or the model blurs them.
  const groups = new Map<string, { resume: ResumeConfig; rows: VacancyRow[] }>()
  for (const v of rows) {
    const route = routeResume(cfg, { title: v.title, description: v.description })
    const g = groups.get(route.resume.id) ?? { resume: route.resume, rows: [] }
    g.rows.push(v)
    groups.set(route.resume.id, g)
  }

  for (const [resumeId, { resume, rows }] of groups) {
    for (let i = 0; i < rows.length; i += cfg.letter.batchSize) {
      const chunk = rows.slice(i, i + cfg.letter.batchSize)
      const targets: LetterTarget[] = chunk.map((v, n) => ({
        index: n + 1,
        title: v.title,
        company: v.company,
        description: v.description,
      }))

      log.info(`${resumeId}: writing ${chunk.length} letters`)
      const letters = await generateLetters(targets, resume, cfg, provider)

      for (const l of letters) {
        const vacancy = chunk[l.index - 1]
        if (!vacancy) continue

        if (!l.ok) {
          // Store nothing rather than a broken letter: an unusable letter in the DB
          // would look approvable in the UI.
          log.warn(`  skipped "${vacancy.title.slice(0, 40)}": ${l.problems.join(', ')}`)
          result.rejected++
          continue
        }

        repo.saveLetter({
          vacancyId: vacancy.id,
          text: l.text,
          model: provider.model,
          promptVersion: PROMPT_VERSION,
        })
        result.written++
        result.byResume[resumeId] = (result.byResume[resumeId] ?? 0) + 1
      }
    }
  }

  return result
}

/**
 * Fetch and store descriptions for any vacancy lacking one.
 *
 * Costs a navigation each, so it is limited to the vacancies actually about to get a
 * letter rather than run across the whole database. Stops rather than pushes through
 * when hh puts up a captcha.
 */
async function ensureDescriptions(
  rows: readonly VacancyRow[],
  cfg: Config,
  repo: Repo,
  result: LettersResult,
): Promise<VacancyRow[]> {
  const missing = rows.filter((v) => !v.description)
  if (missing.length === 0) return [...rows]

  log.info(`reading ${missing.length} vacancy pages for descriptions`)
  const ctx = await openContext(cfg)
  const updated = new Map<number, string>()
  const archived = new Set<number>()

  try {
    const page = await getPage(ctx)
    for (const v of missing) {
      try {
        const details = await fetchVacancyDetails(page, v.url)
        if (details.archived) {
          repo.markArchived(v.id)
          archived.add(v.id)
          log.debug(`archived: ${v.title.slice(0, 40)}`)
        } else if (details.description) {
          repo.setVacancyDetail(v.id, {
            description: details.description,
            hasTest: details.hasTest,
          })
          updated.set(v.id, details.description)
          result.detailsFetched++
        }
      } catch (e) {
        if (e instanceof HumanNeededError) {
          result.stopReason = e.state
          log.error(`stopping: ${e.message}`)
          break
        }
        log.warn(`could not read ${v.url}: ${(e as Error).message}`)
      }
      await randomBetween(cfg.limits.readPauseMsMin, cfg.limits.readPauseMsMax)
      await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
    }
  } finally {
    await ctx.close()
  }

  // An archived vacancy gets no letter — it cannot be applied to.
  return rows
    .filter((v) => !archived.has(v.id))
    .map((v) => (updated.has(v.id) ? { ...v, description: updated.get(v.id)! } : v))
}

export function printLettersResult(r: LettersResult, cfg: Config): void {
  console.log(`\n  requested  ${r.requested}`)
  if (r.detailsFetched) console.log(`  read       ${r.detailsFetched} vacancy pages`)
  console.log(`  written    ${r.written}`)
  if (r.rejected) console.log(`  rejected   ${r.rejected}  (failed validation)`)
  for (const [id, n] of Object.entries(r.byResume)) console.log(`               ${String(n).padStart(4)}  ${id}`)
  if (r.stopReason) console.log(`\n  stopped: ${r.stopReason}`)
  if (r.written > 0) {
    console.log(
      cfg.letter.requireManualApproval
        ? `\n  Letters await approval — review them before applying.`
        : `\n  Manual approval is OFF — these will be sent as written.`,
    )
  }
  console.log()
}
