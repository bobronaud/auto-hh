/**
 * The salary answer for an employer's question form — the owner's rules, applied in
 * order. The figures are `profile.salary` in config.json (personal data, not in git);
 * only the choice of level lives here:
 *
 *   1. the posting names a range → its upper bound (only "от X" → X);
 *   2. "middle" and "senior" both in the title ("Middle/Senior", "Middle+/Senior")
 *      → middleSenior; "senior" alone → senior;
 *   3. "junior" in the title without "middle", or no experience required → junior;
 *   4. 1-3 years → middle;
 *   5. 3-6 years → middleSenior;
 *   6. more than 6 years → senior (not named by the owner; treated as senior);
 *   7. nothing known → middle.
 *
 * Only for forms. Letters still never mention money — the owner turned that off, and
 * this rule set is an answer to a direct question, not something volunteered.
 *
 * Deterministic on purpose: a number is a commitment, and leaving it to the model
 * means a different figure every run for the same posting.
 */

import type { SalaryLevels } from '../config/schema.js'

export interface SalaryInput {
  title: string
  salaryFrom: number | null
  salaryTo: number | null
  currency: string | null
  /** hh's experience line as shown on the vacancy page, e.g. "1–3 года". */
  experience: string | null
}

export type ExperienceBand = 'none' | '1-3' | '3-6' | '6+' | null

/**
 * "не требуется", "1–3 года", "3–6 лет", "более 6 лет". The dash comes as an en dash
 * on hh; it is matched as any non-digit run so a hyphen or a space works too.
 */
export function experienceBand(text: string | null): ExperienceBand {
  if (!text) return null
  const t = text.toLocaleLowerCase('ru')
  if (/не\s+требуется|без\s+опыта/u.test(t)) return 'none'
  if (/1\D{1,3}3/u.test(t)) return '1-3'
  if (/3\D{1,3}6/u.test(t)) return '3-6'
  if (/(?:более|больше|от)\s+6/u.test(t)) return '6+'
  return null
}

// \p{L} rather than \b: the title is often Russian around the English word, and \b is
// ASCII-only in JS — "Senior-разработчик" must count, "Seniority" must not.
const word = (w: string) => new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'iu')
const SENIOR = word('(?:senior|сеньор|синьор)')
const JUNIOR = word('(?:junior|джуниор|джун)')
const MIDDLE = word('(?:middle|мидл)')

export function salaryAnswer(v: SalaryInput, levels: SalaryLevels): string {
  const top = v.salaryTo ?? v.salaryFrom
  if (top) return `${formatAmount(top)} ${currencyLabel(v.currency)}`

  return formatLevel(levels[salaryLevel(v)])
}

function salaryLevel(v: SalaryInput): keyof SalaryLevels {
  const band = experienceBand(v.experience)
  if (SENIOR.test(v.title)) return MIDDLE.test(v.title) ? 'middleSenior' : 'senior'
  if ((JUNIOR.test(v.title) && !MIDDLE.test(v.title)) || band === 'none') return 'junior'
  if (band === '1-3') return 'middle'
  if (band === '3-6') return 'middleSenior'
  if (band === '6+') return 'senior'
  return 'middle'
}

/** 120000 → "120 000 руб", [90000, 120000] → "90 000 - 120 000 руб". */
function formatLevel(level: SalaryLevels[keyof SalaryLevels]): string {
  const text = typeof level === 'number' ? formatAmount(level) : level.map(formatAmount).join(' - ')
  return `${text} руб`
}

/** 120000 → "120 000" with a plain space: a thin space is a typed-by-machine tell. */
export function formatAmount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function currencyLabel(c: string | null): string {
  if (!c || c === 'RUR' || c === 'RUB') return 'руб'
  return c
}
