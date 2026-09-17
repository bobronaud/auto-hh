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

export const PROBLEM_LABEL: Record<LetterProblem, string> = {
  too_long: 'длиннее допустимого',
  too_short: 'подозрительно короткое',
  empty: 'пустое',
  markdown: 'содержит markdown-разметку',
  placeholder: 'содержит незаполненный плейсхолдер',
  meta_commentary: 'содержит служебный текст модели',
}

export interface Validation {
  ok: boolean
  problems: LetterProblem[]
}

/** Square-bracket or curly placeholders the model forgot to fill. */
const PLACEHOLDER = /\[(?:имя|название|компан|вакан|ваше|укажите|your|name|company)[^\]]*\]|\{\{[^}]+\}\}/i

/** The model talking about itself or about the task instead of writing the letter. */
const META =
  /как (?:языковая )?модель|как (?:ии|ai)|я не могу|вот (?:письмо|текст|вариант)|конечно[,!]|надеюсь, это подойд/i

/**
 * Markdown that would be shown literally in hh's plain-text field.
 *
 * \p{L} rather than \w: the latter is ASCII-only in JS, so a bullet list in Russian
 * ("- Опыт работы") sailed straight past this check.
 */
const MARKDOWN = /(\*\*|^#{1,6}\s|^[-*]\s+\p{L}|```)/mu

export function validateLetter(text: string, cfg: Config): Validation {
  const problems: LetterProblem[] = []
  const trimmed = text.trim()

  if (trimmed.length === 0) return { ok: false, problems: ['empty'] }
  if (trimmed.length > cfg.letter.maxChars) problems.push('too_long')
  if (trimmed.length < cfg.letter.minChars) problems.push('too_short')
  if (MARKDOWN.test(trimmed)) problems.push('markdown')
  if (PLACEHOLDER.test(trimmed)) problems.push('placeholder')
  if (META.test(trimmed)) problems.push('meta_commentary')

  return { ok: problems.length === 0, problems }
}

/**
 * Repair what can be repaired without touching meaning: strip markdown emphasis and
 * collapse runaway whitespace. Anything that changes what the letter CLAIMS is left
 * alone — that is a regeneration, not a fix.
 */
export function tidyLetter(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
