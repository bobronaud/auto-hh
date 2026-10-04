/**
 * The salary answer for an employer's question form — the owner's rules, applied in
 * order:
 *
 *   1. the posting names a range → its upper bound (only "от X" → X);
 *   2. "middle" and "senior" both in the title ("Middle/Senior", "Middle+/Senior")
 *      → 150-200k; "senior" alone → 200 000;
 *   3. "junior" in the title without "middle", or no experience required → 100-150k;
 *   4. 1-3 years → 150 000;
 *   5. 3-6 years → 150-200k;
 *   6. more than 6 years → 200 000 (not named by the owner; treated as senior);
 *   7. nothing known → 150 000.
 *
 * Only for forms. Letters still never mention money — the owner turned that off, and
 * this rule set is an answer to a direct question, not something volunteered.
 *
 * Deterministic on purpose: a number is a commitment, and leaving it to the model
 * means a different figure every run for the same posting.
 */

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

export function salaryAnswer(v: SalaryInput): string {
  const top = v.salaryTo ?? v.salaryFrom
  if (top) return `${formatAmount(top)} ${currencyLabel(v.currency)}`

  const band = experienceBand(v.experience)
  if (SENIOR.test(v.title)) return MIDDLE.test(v.title) ? '150 000 - 200 000 руб' : '200 000 руб'
  if ((JUNIOR.test(v.title) && !MIDDLE.test(v.title)) || band === 'none') return '100 000 - 150 000 руб'
  if (band === '1-3') return '150 000 руб'
  if (band === '3-6') return '150 000 - 200 000 руб'
  if (band === '6+') return '200 000 руб'
  return '150 000 руб'
}

/** 200000 → "200 000" with a plain space: a thin space is a typed-by-machine tell. */
export function formatAmount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function currencyLabel(c: string | null): string {
  if (!c || c === 'RUR' || c === 'RUB') return 'руб'
  return c
}
