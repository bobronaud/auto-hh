import { Repo, type VacancyRow } from '../db/repo.js'
import { routeResume } from '../scoring/resumeRouter.js'
import { generateLetters } from '../letters/generate.js'
import { PROMPT_VERSION, type LetterTarget } from '../letters/prompt.js'
import { createProvider } from '../llm/provider.js'
import { logger } from '../core/logger.js'
import type { Config, ResumeConfig } from '../config/schema.js'

const log = logger('letters')

export interface LettersResult {
  requested: number
  written: number
  rejected: number
  byResume: Record<string, number>
}

/**
 * Write letters for the vacancies that are next in line.
 *
 * Grouped by resume and sent in batches, because the per-call overhead dwarfs the
 * payload — see letters/generate.ts. Letters are stored unapproved; nothing here
 * touches hh.
 */
export async function writeLetters(cfg: Config, limit: number): Promise<LettersResult> {
  const repo = new Repo()
  const provider = createProvider(cfg)

  const pending = repo.vacanciesNeedingLetters(limit)
  const result: LettersResult = { requested: pending.length, written: 0, rejected: 0, byResume: {} }
  if (pending.length === 0) return result

  // One batch per resume: a single call must not mix stacks, or the model blurs them.
  const groups = new Map<string, { resume: ResumeConfig; rows: VacancyRow[] }>()
  for (const v of pending) {
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

export function printLettersResult(r: LettersResult, cfg: Config): void {
  console.log(`\n  requested  ${r.requested}`)
  console.log(`  written    ${r.written}`)
  if (r.rejected) console.log(`  rejected   ${r.rejected}  (failed validation)`)
  for (const [id, n] of Object.entries(r.byResume)) console.log(`               ${String(n).padStart(4)}  ${id}`)
  if (r.written > 0) {
    console.log(
      cfg.letter.requireManualApproval
        ? `\n  Letters await approval — review them before applying.`
        : `\n  Manual approval is OFF — these will be sent as written.`,
    )
  }
  console.log()
}
