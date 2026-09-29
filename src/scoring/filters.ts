import type { Config } from '../config/schema.js'
import type { ScrapedCard } from '../hh/search.js'
import { countMatchingWords, normalizeText } from './textMatch.js'

/**
 * Cheap local filters, applied before anything expensive (RESEARCH §3.2).
 *
 * Every vacancy dropped here is an LLM call not made and a navigation not spent, so
 * the order runs cheapest-first. Nothing in this file talks to hh or to a model.
 */

export type DropReason =
  | 'already_applied'
  | 'has_test'
  | 'company_blacklist'
  | 'title_blacklist'
  | 'not_frontend'

export const DROP_LABEL: Record<DropReason, string> = {
  already_applied: 'уже откликались',
  has_test: 'тестовое задание',
  company_blacklist: 'компания в чёрном списке',
  title_blacklist: 'стоп-слово в названии',
  not_frontend: 'не фронтенд',
}

export interface FilterVerdict {
  keep: boolean
  reason?: DropReason
}

const lc = (s: string | null | undefined) => normalizeText(s ?? '').toLocaleLowerCase('ru')

export function filterCard(
  card: ScrapedCard,
  cfg: Config,
  appliedIds: ReadonlySet<string>,
): FilterVerdict {
  // Our own history, plus what hh itself shows in the card — hh also knows about
  // applications made by hand or from the phone, which our database never saw.
  if (appliedIds.has(card.hhId) || card.alreadyAppliedOnHh) {
    return { keep: false, reason: 'already_applied' }
  }

  // hasTest is null when the card simply did not say — only a confirmed test drops.
  if (cfg.filters.skipWithTest && card.hasTest === true) {
    return { keep: false, reason: 'has_test' }
  }

  const title = lc(card.title)
  const company = lc(card.company)

  if (cfg.filters.companyBlacklist.some((b) => company.includes(lc(b)))) {
    return { keep: false, reason: 'company_blacklist' }
  }
  if (cfg.filters.titleBlacklist.some((b) => title.includes(lc(b)))) {
    return { keep: false, reason: 'title_blacklist' }
  }

  // The only substantive question: is this frontend at all? Matched against the
  // title, which is all a search card carries. Everything else — salary, years,
  // remote or office — is left alone on purpose: filtering on it costs applications
  // for criteria that are negotiable anyway.
  if (cfg.scoring.requiredKeywordHits > 0 && cfg.scoring.keywords.length > 0) {
    const hits = countMatchingWords(card.title, cfg.scoring.keywords)
    if (hits < cfg.scoring.requiredKeywordHits) return { keep: false, reason: 'not_frontend' }
  }

  return { keep: true }
}

export interface FilterSummary {
  kept: ScrapedCard[]
  dropped: Array<{ card: ScrapedCard; reason: DropReason }>
  counts: Record<string, number>
}

export function applyFilters(
  cards: readonly ScrapedCard[],
  cfg: Config,
  appliedIds: ReadonlySet<string>,
): FilterSummary {
  const kept: ScrapedCard[] = []
  const dropped: Array<{ card: ScrapedCard; reason: DropReason }> = []
  const counts: Record<string, number> = {}

  for (const card of cards) {
    const v = filterCard(card, cfg, appliedIds)
    if (v.keep) {
      kept.push(card)
    } else {
      dropped.push({ card, reason: v.reason! })
      counts[v.reason!] = (counts[v.reason!] ?? 0) + 1
    }
  }
  return { kept, dropped, counts }
}
