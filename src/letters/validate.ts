import type { Config } from '../config/schema.js'

/**
 * Checks a generated letter before it can ever reach an employer.
 *
 * The length rule exists because hh rejects over-long letters (too_long_message) —
 * and since the field carries no maxlength attribute, the cap in config is a measured
 * guess, so we stay well under it. The rest catch the ways an LLM quietly ruins a
 * letter: markdown that renders as literal asterisks, a leftover placeholder, or an
 * apology about being an AI.
 */

export type LetterProblem =
  | 'too_long'
  | 'too_short'
  | 'empty'
  | 'markdown'
  | 'placeholder'
  | 'meta_commentary'
  | 'typography'
  | 'self_deprecating'
  | 'signature'

export const PROBLEM_LABEL: Record<LetterProblem, string> = {
  too_long: 'длиннее допустимого',
  too_short: 'подозрительно короткое',
  empty: 'пустое',
  markdown: 'содержит markdown-разметку',
  placeholder: 'содержит незаполненный плейсхолдер',
  meta_commentary: 'содержит служебный текст модели',
  typography: 'символы, которых нет на клавиатуре (длинное тире и подобные)',
  self_deprecating: 'признаётся, что чего-то не знает или не делал',
  signature: 'подписано именем или контактами',
}

/**
 * Characters a person does not type.
 *
 * The em dash is the giveaway the owner named first: a model reaches for it in every
 * second sentence and a human writing in a browser textarea never does. The rest of
 * the set is the same tell — typographic quotes, a one-character ellipsis, non-breaking
 * and thin spaces, emoji. `tidyLetter` replaces all of them, so reaching this check
 * means the repair missed something new.
 */
export const TYPOGRAPHY =
  /[—–―…«»“”„‘’‹›•‣▪◦→←⇒✓✔★]|[\u00a0\u202f\u2009\u200b]|[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/u

/**
 * Admitting a gap. Never send this: the letter's whole job is to make the candidate
 * look like the obvious fit, and a missing technology is left unmentioned rather than
 * apologised for. "Быстро освою" belongs here too — it names the gap just as loudly.
 *
 * \p{L} throughout: \w and \b are ASCII-only in JS and match nothing in Russian.
 */
export const SELF_DEPRECATING =
  /не\s+(?:работал|использовал|применял|знаком|владею|имею\s+опыт|приходилось|доводилось|успел)|нет\s+(?:коммерческого\s+)?опыта|отсутств\p{L}*\s+опыт|пока\s+не\s+\p{L}*(?:работал|использовал|знаком)|быстро\s+(?:освою|изучу|разберусь|выучу|подтяну)|готов\s+(?:изучить|освоить|научиться|подтянуть)|только\s+начинаю|слаб\p{L}*\s+сторон|без\s+(?:\p{L}+\s+){0,2}опыта|не\s+(?:пугает|страшно|смущает|проблема)|хотя\s+и\s+не\s/iu

/**
 * A sign-off. The letter is attached to the resume, which already carries the name and
 * the contacts — repeating them there reads as a template, not as a person.
 */
// Only a sign-off FOLLOWED BY A NAME counts: "с уважением к вашему продукту" is a
// sentence, "С уважением, Борис" is a signature. The leading letter is spelled in both
// cases rather than using /i, which under /u would fold \p{Lu} and match either.
const SIGN_OFF = /[Сс]\s+уважением[,!]?\s*\p{Lu}\p{L}+|[Bb]est\s+regards|[Ss]incerely,/u
const CONTACTS =
  /[\w.+-]+@[\w-]+\.\p{L}{2,}|\+7[\s(-]?\d{3}|\b8\s?\(?9\d{2}\)?[\s-]?\d{3}|t\.me\/|телеграм|telegram|whatsapp|вотсап/iu

export interface Validation {
  ok: boolean
  problems: LetterProblem[]
  /**
   * The exact text that tripped each pattern.
   *
   * Without it a rejection is unreportable: the letter is never stored, so "признаётся,
   * что чего-то не знает" names a verdict nobody can check against a text that no
   * longer exists. Same rule the hh detectors follow — a detector that stops work has
   * to say what fired.
   */
  matched: Partial<Record<LetterProblem, string>>
}

/** Square-bracket or curly placeholders the model forgot to fill. */
const PLACEHOLDER = /\[(?:имя|название|компан|вакан|ваше|укажите|your|name|company)[^\]]*\]|\{\{[^}]+\}\}/i

/** The model talking about itself or about the task instead of writing the letter. */
export const META =
  /как (?:языковая )?модель|как (?:ии|ai)|я не могу|вот (?:письмо|текст|вариант)|конечно[,!]|надеюсь, это подойд/i

/**
 * Markdown that would be shown literally in hh's plain-text field.
 *
 * \p{L} rather than \w: the latter is ASCII-only in JS, so a bullet list in Russian
 * ("- Опыт работы") sailed straight past this check.
 */
export const MARKDOWN = /(\*\*|^#{1,6}\s|^[-*]\s+\p{L}|```)/mu

export function validateLetter(text: string, cfg: Config): Validation {
  const problems: LetterProblem[] = []
  const matched: Partial<Record<LetterProblem, string>> = {}
  const trimmed = text.trim()

  /** Records the problem along with the fragment that caused it. */
  const hit = (problem: LetterProblem, ...res: RegExp[]): void => {
    for (const re of res) {
      const m = trimmed.match(re)
      if (m) {
        problems.push(problem)
        matched[problem] = quote(trimmed, m)
        return
      }
    }
  }

  if (trimmed.length === 0) return { ok: false, problems: ['empty'], matched }
  if (trimmed.length > cfg.letter.maxChars) problems.push('too_long')
  if (trimmed.length < cfg.letter.minChars) problems.push('too_short')
  hit('markdown', MARKDOWN)
  hit('placeholder', PLACEHOLDER)
  hit('meta_commentary', META)
  hit('typography', TYPOGRAPHY)
  hit('self_deprecating', SELF_DEPRECATING)
  hit('signature', SIGN_OFF, CONTACTS)

  return { ok: problems.length === 0, problems, matched }
}

/** The match with a few words either side — a bare match is rarely enough to judge. */
function quote(text: string, m: RegExpMatchArray): string {
  const at = m.index ?? 0
  const from = Math.max(0, at - 40)
  const to = Math.min(text.length, at + m[0].length + 40)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`
}

/**
 * Repair what can be repaired without touching meaning: strip markdown emphasis and
 * collapse runaway whitespace. Anything that changes what the letter CLAIMS is left
 * alone — that is a regeneration, not a fix.
 */
export function tidyLetter(text: string): string {
  return (
    text
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      // Typography: swap every character a keyboard does not have for the one it does.
      // This is a repair rather than a rewrite — the words are untouched — and it is
      // what keeps the letter from reading as machine-written at a glance.
      .replace(/[—–―]/g, '-')
      .replace(/…/g, '...')
      .replace(/[«»“”„‹›]/g, '"')
      .replace(/[‘’‚]/g, "'")
      .replace(/[\u00a0\u202f\u2009\u200b]/g, ' ')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
