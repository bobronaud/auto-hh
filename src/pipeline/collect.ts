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
  stored: number
  kept: number
  dropped: Record<string, number>
  byResume: Record<string, number>
  needDetail: number
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
    const { kept, counts } = applyFilters(cards, cfg, appliedIds)

    const byResume: Record<string, number> = {}
    let stored = 0
    let needDetail = 0

    for (const card of kept) {
      repo.upsertVacancy(card)
      stored++

      // Route on the title alone. When the title is not decisive the description is
      // needed — but reading it costs a navigation, so that is deferred to the apply
      // step rather than spent here on vacancies that may never be applied to.
      const route = routeResume(cfg, { title: card.title })
      byResume[route.resume.id] = (byResume[route.resume.id] ?? 0) + 1
      if (!route.decidedByTitle) needDetail++
    }

    return { scraped: cards.length, stored, kept: kept.length, dropped: counts, byResume, needDetail }
  } finally {
    await ctx.close()
  }
}

export function printCollectResult(r: CollectResult): void {
  console.log(`\n  scraped   ${r.scraped}`)
  console.log(`  kept      ${r.kept}`)

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
  if (r.needDetail > 0) {
    console.log(`\n  ${r.needDetail} vacancies need their description read before routing is certain.`)
  }
  console.log()
}
