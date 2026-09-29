import { openContext, getPage } from '../hh/browser.js'
import { collectVacancies } from '../hh/search.js'
import { applyFilters, DROP_LABEL, type DropReason } from '../scoring/filters.js'
import { routeResume } from '../scoring/resumeRouter.js'
import { Repo } from '../db/repo.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

const log = logger('collect')

export interface CollectResult {
  scraped: number
  /** Passed the filters and is waiting in the queue after this collect. */
  queued: number
  /**
   * Passed the filters but the queue will not take it: already dealt with in some way
   * other than an application — parked for manual work, skipped, failed, dismissed.
   * The filters only know about 'applied', so without this count those looked like
   * fresh additions to the queue.
   */
  handled: number
  dropped: Record<string, number>
  /** Resume routing of the queued vacancies, by title. */
  byResume: Record<string, number>
}

/**
 * Scrape the search results, filter them, route each survivor to a resume, and store
 * everything. Sends nothing — this is the "what would it do" half of the pipeline,
 * meant to be run and read before anything is submitted.
 */
export async function collect(cfg: Config): Promise<CollectResult> {
  const repo = new Repo()
  const ctx = await openContext(cfg)

  try {
    const page = await getPage(ctx)
    const cards = await collectVacancies(page, cfg)
    log.info(`scraped ${cards.length} unique vacancies`)

    const appliedIds = repo.appliedHhIds()
    const { kept, dropped, counts } = applyFilters(cards, cfg, appliedIds)

    // Kept for analysis in the database only: which titles the keyword list misses.
    for (const d of dropped) if (d.reason === 'not_frontend') repo.recordDropped(d.card, d.reason)

    const byResume: Record<string, number> = {}
    let queued = 0

    for (const card of kept) {
      const id = repo.upsertVacancy(card)
      if (!repo.isQueued(id)) continue
      queued++

      // Route on the title alone: the description is read later, at apply time, and
      // only for vacancies that actually get answered.
      const route = routeResume(cfg, { title: card.title })
      byResume[route.resume.id] = (byResume[route.resume.id] ?? 0) + 1
    }

    return { scraped: cards.length, queued, handled: kept.length - queued, dropped: counts, byResume }
  } finally {
    await ctx.close()
  }
}

export function printCollectResult(r: CollectResult): void {
  console.log(`\n  scraped   ${r.scraped}`)
  console.log(`  queued    ${r.queued}`)
  if (r.handled > 0) console.log(`  handled   ${r.handled} already dealt with (manual, skipped, failed, dismissed)`)

  const droppedTotal = Object.values(r.dropped).reduce((a, b) => a + b, 0)
  if (droppedTotal > 0) {
    console.log(`  dropped   ${droppedTotal}`)
    for (const [reason, n] of Object.entries(r.dropped).sort((a, b) => b[1] - a[1])) {
      const label = DROP_LABEL[reason as DropReason] ?? reason
      console.log(`              ${String(n).padStart(4)}  ${label}`)
    }
  }

  console.log(`\n  routing (by title):`)
  for (const [id, n] of Object.entries(r.byResume).sort((a, b) => b[1] - a[1])) {
    console.log(`              ${String(n).padStart(4)}  ${id}`)
  }
  console.log()
}
