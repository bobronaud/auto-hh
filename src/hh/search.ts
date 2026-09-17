import type { Page } from 'playwright'
import { selectors } from './selectors.js'
import { buildSearchUrl } from './searchUrl.js'
import { goto, pause, randomBetween } from './browser.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'
import type { VacancyInput } from '../db/repo.js'

const log = logger('search')

/**
 * Collect vacancies by scraping the search results page.
 *
 * This is the only source of vacancies now that hh's API is closed (RESEARCH §1.4),
 * which makes every field here worth more than it looks: whatever the card does not
 * tell us costs an extra navigation to the vacancy page to find out.
 */

export interface ScrapedCard extends VacancyInput {
  /** Apply straight from the results list — saves opening the vacancy page. */
  canApplyFromList: boolean
}

/** hh vacancy id out of any of its URL shapes. */
export function vacancyIdFromUrl(url: string): string | null {
  const m = /\/vacancy\/(\d+)/.exec(url)
  return m?.[1] ?? null
}

/**
 * Salary text → numbers. hh writes these many ways ("от 200 000 ₽", "100 000 –
 * 150 000 руб.", "до 3 500 $"), with non-breaking and thin spaces inside the digits.
 */
export function parseSalary(text: string | null | undefined): {
  from: number | null
  to: number | null
  currency: string | null
} {
  if (!text) return { from: null, to: null, currency: null }

  const t = text.replace(/[   ]/g, ' ').toLocaleLowerCase('ru')
  const currency = /₽|руб/.test(t) ? 'RUR' : /\$|usd/.test(t) ? 'USD' : /€|eur/.test(t) ? 'EUR' : null

  const numbers = [...t.matchAll(/(\d[\d ]*)/g)]
    .map((m) => Number(m[1]!.replace(/ /g, '')))
    .filter((n) => Number.isFinite(n) && n > 0)

  if (numbers.length === 0) return { from: null, to: null, currency }

  // \b is ASCII-only in JS, so /^\s*до\b/ never fires on Cyrillic "до" — it would
  // silently fall through and read "до 250 000" as a lower bound, inverting the
  // salary filter. Match the following whitespace explicitly instead.
  if (/^\s*до\s/.test(t)) return { from: null, to: numbers[0]!, currency }
  if (/^\s*от\s/.test(t) && numbers.length === 1) return { from: numbers[0]!, to: null, currency }
  if (numbers.length === 1) return { from: numbers[0]!, to: null, currency }
  return { from: numbers[0]!, to: numbers[1]!, currency }
}

/** Read every card on the current results page. */
async function scrapePage(page: Page): Promise<ScrapedCard[]> {
  const sel = {
    card: selectors.search.card[0]!,
    title: selectors.search.cardTitleLink[0]!,
    company: selectors.search.cardCompany[0]!,
    area: selectors.search.cardArea[0]!,
    salary: '[data-qa*="compensation"]',
    test: selectors.search.cardHasTest[0]!,
    apply: selectors.search.cardApplyButton[0]!,
  }

  const raw = await page.locator(sel.card).evaluateAll((els, s) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim() || null
    return els.map((el) => {
      const link = el.querySelector(s.title) as HTMLAnchorElement | null
      return {
        url: link?.href ?? null,
        title: txt(link),
        company: txt(el.querySelector(s.company)),
        area: txt(el.querySelector(s.area)),
        salary: txt(el.querySelector(s.salary)),
        hasTest: el.querySelector(s.test) !== null,
        canApplyFromList: el.querySelector(s.apply) !== null,
      }
    })
  }, sel)

  const cards: ScrapedCard[] = []
  for (const r of raw) {
    if (!r.url || !r.title) continue
    const hhId = vacancyIdFromUrl(r.url)
    if (!hhId) continue

    const salary = parseSalary(r.salary)
    cards.push({
      hhId,
      // Strip the tracking query so the same vacancy has one stable URL.
      url: r.url.split('?')[0]!,
      title: r.title,
      company: r.company,
      area: r.area,
      salaryFrom: salary.from,
      salaryTo: salary.to,
      salaryCurrency: salary.currency,
      // The card only ever proves a test EXISTS. Its absence proves nothing, so this
      // stays null rather than false — a later detail scrape must be able to fill it.
      hasTest: r.hasTest ? true : null,
      responseLetterRequired: null,
      canApplyFromList: r.canApplyFromList,
      raw: r,
    })
  }
  return cards
}

/** Are there more result pages after this one? */
async function hasMorePages(page: Page, currentPage: number): Promise<boolean> {
  const pages = await page
    .locator(selectors.search.pagerPage[0]!)
    .evaluateAll((els) => els.map((e) => Number((e.textContent ?? '').trim())).filter(Boolean))
    .catch(() => [] as number[])
  if (pages.length === 0) return false
  return Math.max(...pages) > currentPage + 1
}

/**
 * Walk the search results. Stops at maxPages, at the last page, or as soon as a page
 * yields nothing — an empty page usually means hh stopped serving results rather than
 * that we genuinely reached the end.
 */
export async function collectVacancies(page: Page, cfg: Config): Promise<ScrapedCard[]> {
  const all = new Map<string, ScrapedCard>()

  for (let p = 0; p < cfg.search.maxPages; p++) {
    const url = buildSearchUrl(cfg.search, p)
    log.info(`page ${p + 1}/${cfg.search.maxPages}`)
    await goto(page, url)
    await randomBetween(cfg.limits.readPauseMsMin, cfg.limits.readPauseMsMax)

    const cards = await scrapePage(page)
    if (cards.length === 0) {
      log.warn('no cards on this page — stopping')
      break
    }

    let fresh = 0
    for (const c of cards) {
      if (!all.has(c.hhId)) fresh++
      all.set(c.hhId, c)
    }
    log.info(`  ${cards.length} cards, ${fresh} new (${all.size} total)`)

    if (!(await hasMorePages(page, p))) {
      log.info('last page reached')
      break
    }
    await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
  }

  return [...all.values()]
}
