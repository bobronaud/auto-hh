import type { Config, ResumeConfig } from '../config/schema.js'

/**
 * Pick which resume answers a vacancy (React vs Vue).
 *
 * The vacancy decides, not the config. A title hit weighs far more than a body hit:
 * "Vue-разработчик" whose description mentions React in passing ("опыт с React будет
 * плюсом") is a Vue vacancy, and matching on raw body counts would get that backwards.
 */

export interface RouteInput {
  title: string
  /** Vacancy body. Often unavailable from a search card — see `decidedByTitle`. */
  description?: string | null
}

export interface RouteResult {
  resume: ResumeConfig | null
  reason: string
  scores: Record<string, number>
  /** True when the title alone settled it — no need to open the vacancy page. */
  decidedByTitle: boolean
  ambiguous: boolean
}

/** Whole-word-ish match so "vue" does not fire inside "value" or "revue". */
function countHits(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Cyrillic and Latin letters are both "word" characters here; digits and + stay
  // attached so "vue3" and "c++" behave.
  const re = new RegExp(`(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`, 'giu')
  return (haystack.match(re) ?? []).length
}

function scoreResume(
  resume: ResumeConfig,
  title: string,
  body: string,
  titleWeight: number,
): number {
  for (const bad of resume.exclude) {
    if (countHits(title, bad) > 0 || countHits(body, bad) > 0) return 0
  }
  let score = 0
  for (const m of resume.match) {
    score += countHits(title, m) * titleWeight
    score += countHits(body, m)
  }
  return score
}

export function routeResume(cfg: Config, input: RouteInput): RouteResult {
  const { titleWeight, minScore, skipOnTie, fallbackResumeId } = cfg.routing
  const title = input.title ?? ''
  const body = input.description ?? ''

  const scores: Record<string, number> = {}
  const titleOnly: Record<string, number> = {}
  for (const r of cfg.resumes) {
    scores[r.id] = scoreResume(r, title, body, titleWeight)
    titleOnly[r.id] = scoreResume(r, title, '', titleWeight)
  }

  const ranked = [...cfg.resumes].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))
  const top = ranked[0]
  const second = ranked[1]
  const topScore = top ? (scores[top.id] ?? 0) : 0
  const secondScore = second ? (scores[second.id] ?? 0) : 0

  const fallback = cfg.resumes.find((r) => r.id === fallbackResumeId) ?? null

  if (!top || topScore < minScore) {
    return {
      resume: fallback,
      reason: fallback
        ? `no stack marker found — falling back to "${fallback.id}"`
        : 'no stack marker found and no fallback configured',
      scores,
      decidedByTitle: false,
      ambiguous: false,
    }
  }

  if (second && topScore === secondScore) {
    return {
      resume: skipOnTie ? null : fallback,
      reason: `ambiguous: "${top.id}" and "${second.id}" tie at ${topScore}`,
      scores,
      decidedByTitle: false,
      ambiguous: true,
    }
  }

  // Did the title alone already pick this winner? If so a search card is enough and
  // we can skip opening the vacancy page just to route.
  const titleRanked = [...cfg.resumes].sort((a, b) => (titleOnly[b.id] ?? 0) - (titleOnly[a.id] ?? 0))
  const titleTop = titleRanked[0]
  const decidedByTitle =
    !!titleTop &&
    titleTop.id === top.id &&
    (titleOnly[titleTop.id] ?? 0) >= minScore &&
    (titleOnly[titleTop.id] ?? 0) > (titleRanked[1] ? (titleOnly[titleRanked[1].id] ?? 0) : 0)

  return {
    resume: top,
    reason: decidedByTitle
      ? `title says "${top.id}" (${topScore} vs ${secondScore})`
      : `body says "${top.id}" (${topScore} vs ${secondScore})`,
    scores,
    decidedByTitle,
    ambiguous: false,
  }
}
