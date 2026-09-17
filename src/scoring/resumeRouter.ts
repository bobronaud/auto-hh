import type { Config, ResumeConfig } from '../config/schema.js'

/**
 * Pick which resume answers a vacancy (React vs Vue).
 *
 * Two rules, in this order:
 *
 *   1. A title hit weighs far more than a body hit. "Vue-разработчик" whose
 *      description mentions React in passing ("опыт с React будет плюсом") is a Vue
 *      vacancy; counting raw body mentions would get that backwards.
 *   2. Anything not clearly won by a specialised resume goes to the fallback. This
 *      function NEVER declines to answer — maximum coverage is the point of the tool,
 *      and a React resume is a defensible answer to an unlabelled Frontend vacancy.
 */

export interface RouteInput {
  title: string
  /** Vacancy body. Often unavailable from a search card — see `decidedByTitle`. */
  description?: string | null
}

export interface RouteResult {
  /** Always a resume — routing never returns "none". */
  resume: ResumeConfig
  reason: string
  scores: Record<string, number>
  /** True when the title alone settled it — no need to open the vacancy page. */
  decidedByTitle: boolean
  /** The fallback answered because nothing won outright. Still an application. */
  usedFallback: boolean
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
  const { titleWeight, minScore, fallbackResumeId } = cfg.routing
  const title = input.title ?? ''
  const body = input.description ?? ''

  // Config validation guarantees this resolves.
  const fallback = cfg.resumes.find((r) => r.id === fallbackResumeId)!

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

  const fell = (reason: string): RouteResult => ({
    resume: fallback,
    reason,
    scores,
    decidedByTitle: false,
    usedFallback: true,
  })

  if (!top || topScore < minScore) return fell('no stack marker — fallback')
  if (second && topScore === secondScore) {
    return fell(`both stacks named equally (${topScore}) — fallback`)
  }
  if (top.id === fallback.id) {
    // The fallback won on merit rather than by default; worth distinguishing in logs.
    return {
      resume: top,
      reason: `"${top.id}" wins (${topScore} vs ${secondScore})`,
      scores,
      decidedByTitle: decidedByTitle(cfg, titleOnly, top.id, minScore),
      usedFallback: false,
    }
  }

  return {
    resume: top,
    reason: `"${top.id}" wins (${topScore} vs ${secondScore})`,
    scores,
    decidedByTitle: decidedByTitle(cfg, titleOnly, top.id, minScore),
    usedFallback: false,
  }
}

/**
 * Did the title alone already pick this winner? If so a search card is enough and we
 * can skip opening the vacancy page just to route — navigations are expensive now
 * that the API is closed.
 */
function decidedByTitle(
  cfg: Config,
  titleOnly: Record<string, number>,
  winnerId: string,
  minScore: number,
): boolean {
  const ranked = [...cfg.resumes].sort((a, b) => (titleOnly[b.id] ?? 0) - (titleOnly[a.id] ?? 0))
  const top = ranked[0]
  if (!top || top.id !== winnerId) return false
  const topScore = titleOnly[top.id] ?? 0
  const secondScore = ranked[1] ? (titleOnly[ranked[1].id] ?? 0) : 0
  return topScore >= minScore && topScore > secondScore
}
