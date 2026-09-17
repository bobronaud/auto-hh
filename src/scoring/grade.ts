import { countWordHits } from './textMatch.js'

/**
 * Work out the seniority a vacancy is aimed at, so the letter can name a salary that
 * matches it.
 *
 * The title is trusted first and the description only as a fallback: a description
 * routinely mentions "работа с senior-разработчиками" or "вырастешь до сеньора" while
 * the position itself is middle, and reading those as the grade would quote a number
 * a third too high.
 */

export type Grade = 'junior' | 'middle' | 'senior'

const TITLE_MARKERS: Record<Grade, string[]> = {
  junior: ['junior', 'jr', 'джуниор', 'джун', 'стажер', 'стажёр', 'intern', 'trainee', 'начинающий'],
  middle: ['middle', 'мидл', 'миддл', 'mid'],
  senior: ['senior', 'sr', 'сеньор', 'синьор', 'ведущий', 'lead', 'lead', 'техлид', 'teamlead', 'тимлид', 'principal', 'staff'],
}

/** "опыт от 5 лет" and friends — the most reliable signal a description carries. */
const YEARS = /опыт[^.\n]{0,40}?от\s*(\d+)\s*(?:лет|год)/i
const YEARS_RANGE = /(?:опыт|experience)[^.\n]{0,30}?(\d+)\s*[-–—]\s*(\d+)\s*(?:лет|год)/i

export interface GradeVerdict {
  grade: Grade
  reason: string
  /** False when nothing matched and the default was used. */
  confident: boolean
}

export function detectGrade(title: string, description?: string | null): GradeVerdict {
  // 1. The title wins outright. "Middle+/Senior" counts as senior — the higher of the
  //    two is what the employer is willing to pay for.
  const inTitle = (g: Grade) => TITLE_MARKERS[g].some((m) => countWordHits(title, m) > 0)
  if (inTitle('senior')) return { grade: 'senior', reason: 'senior in title', confident: true }
  if (inTitle('junior')) return { grade: 'junior', reason: 'junior in title', confident: true }
  if (inTitle('middle')) return { grade: 'middle', reason: 'middle in title', confident: true }

  // 2. Years of experience required.
  const body = description ?? ''
  const range = YEARS_RANGE.exec(body)
  const from = range ? Number(range[1]) : YEARS.exec(body) ? Number(YEARS.exec(body)![1]) : null
  if (from !== null && Number.isFinite(from)) {
    if (from >= 5) return { grade: 'senior', reason: `от ${from} лет опыта`, confident: true }
    if (from >= 2) return { grade: 'middle', reason: `от ${from} лет опыта`, confident: true }
    return { grade: 'junior', reason: `от ${from} лет опыта`, confident: true }
  }

  // 3. Nothing said. Middle is the safe default: it is the commonest grade, and an
  //    over-ask on a junior role costs the application outright.
  return { grade: 'middle', reason: 'grade not stated — default', confident: false }
}
