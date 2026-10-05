import { createProvider, type LlmProvider } from '../llm/provider.js'
import { readResumeText } from '../letters/generate.js'
import { tidyLetter, TYPOGRAPHY, SELF_DEPRECATING, MARKDOWN, META } from '../letters/validate.js'
import { systemPrompt, formPrompt, type FormPromptInput } from './prompt.js'
import { ANSWER_MAX_CHARS, OPEN_OPTION_VALUE, type FormAnswer, type FormQuestion } from './types.js'
import { logger } from '../core/logger.js'
import type { Config, ResumeConfig } from '../config/schema.js'

const log = logger('answers')

export type FormAnswers =
  | { ok: true; answers: Map<number, FormAnswer> }
  /** `reason` names the question and what went wrong — it is what the owner reads. */
  | { ok: false; reason: string }

/**
 * Answer a whole form in one model call.
 *
 * One call per form, not per question: every claude-cli invocation re-sends Claude
 * Code's system prompt, and the questions of one form share all their context anyway.
 * Forms cannot be batched across vacancies the way letters are — a form only exists
 * once "Откликнуться" has been pressed.
 *
 * All or nothing. A form filled except for one question is not sent: hh would refuse
 * it, or worse, accept a blank where the employer asked something.
 */
export async function answerForm(
  input: Omit<FormPromptInput, 'resumeText'> & { resume: ResumeConfig },
  cfg: Config,
  provider: LlmProvider = createProvider(cfg),
): Promise<FormAnswers> {
  let text: string
  try {
    const result = await provider.complete({
      system: systemPrompt(),
      prompt: formPrompt({ ...input, resumeText: readResumeText(input.resume) }, cfg),
    })
    text = result.text
  } catch (e) {
    return { ok: false, reason: `LLM не ответила: ${(e as Error).message}` }
  }
  log.debug(`form answers, raw: ${text}`)
  return interpretAnswers(text, input.questions)
}

/** Parse and check the model's reply against the questions it was given. */
export function interpretAnswers(text: string, questions: readonly FormQuestion[]): FormAnswers {
  const blocks = parseBlocks(text)
  const answers = new Map<number, FormAnswer>()

  for (const q of questions) {
    const block = blocks.get(q.index)
    const where = `вопрос ${q.index} «${short(q.text)}»`
    if (!block) return { ok: false, reason: `${where}: модель не ответила` }
    if (block.unknown) {
      return { ok: false, reason: `${where}: модель не знает ответа — ${block.body || 'без причины'}` }
    }
    const checked = q.kind === 'text' ? checkText(block.body) : checkChoice(block.body, q)
    if ('problem' in checked) return { ok: false, reason: `${where}: ${checked.problem}` }
    answers.set(q.index, checked.answer)
  }
  return { ok: true, answers }
}

interface Block {
  unknown: boolean
  body: string
}

/** `###ОТВЕТ N###` / `###НЕ ЗНАЮ N###`, each followed by its body up to the next one. */
export function parseBlocks(text: string): Map<number, Block> {
  const out = new Map<number, Block>()
  const re = /###\s*(ОТВЕТ|НЕ\s+ЗНАЮ)\s+(\d+)\s*###/giu
  const marks = [...text.matchAll(re)]
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < marks.length ? (marks[i + 1]!.index ?? text.length) : text.length
    out.set(Number(m[2]), {
      unknown: !/ОТВЕТ/iu.test(m[1]!),
      body: text.slice(start, end).trim(),
    })
  })
  return out
}

function checkText(raw: string): { answer: FormAnswer } | { problem: string } {
  const text = tidyLetter(raw)
  const problem = textProblem(text)
  return problem ? { problem } : { answer: { kind: 'text', text } }
}

/**
 * The same checks a letter gets, minus the ones that do not apply: a GitHub link is a
 * legitimate answer here, and a one-word "Да" is not "suspiciously short".
 */
export function textProblem(text: string): string | null {
  if (!text) return 'пустой ответ'
  if (text.length > ANSWER_MAX_CHARS) return `ответ длиннее ${ANSWER_MAX_CHARS} символов (${text.length})`
  for (const [re, label] of [
    [TYPOGRAPHY, 'символы, которых нет на клавиатуре'],
    [SELF_DEPRECATING, 'признаётся, что чего-то не знает или не делал'],
    [MARKDOWN, 'markdown-разметка'],
    [META, 'служебный текст модели'],
  ] as const) {
    const m = text.match(re)
    if (m) return `${label} — «${short(text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + m[0].length + 30))}»`
  }
  return null
}

function checkChoice(raw: string, q: FormQuestion): { answer: FormAnswer } | { problem: string } {
  const [first = '', ...rest] = raw.split('\n')
  const picks = [...first.matchAll(/\d+/g)].map((m) => Number(m[0]))
  if (picks.length === 0) return { problem: `не выбран ни один вариант («${short(first)}»)` }
  if (q.kind === 'radio' && picks.length !== 1) return { problem: `выбрано ${picks.length} вариантов, нужен один` }

  const values: string[] = []
  for (const n of new Set(picks)) {
    const opt = q.options[n - 1]
    if (!opt) return { problem: `варианта ${n} нет (их ${q.options.length})` }
    values.push(opt.value)
  }

  if (!values.includes(OPEN_OPTION_VALUE)) return { answer: { kind: 'choice', values, text: null } }

  const text = tidyLetter(rest.join('\n'))
  if (!text) return { problem: 'выбран «Свой вариант», но текста нет' }
  const problem = textProblem(text)
  return problem ? { problem } : { answer: { kind: 'choice', values, text } }
}

function short(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 80 ? `${t.slice(0, 80)}...` : t
}

/** The answer as the owner would read it: option labels rather than hh's value ids. */
export function describeAnswer(q: FormQuestion, a: FormAnswer): string {
  if (a.kind === 'text') return a.text
  const labels = a.values
    .filter((v) => v !== OPEN_OPTION_VALUE)
    .map((v) => q.options.find((o) => o.value === v)?.label ?? v)
  if (a.text) labels.push(`свой вариант: ${a.text}`)
  return labels.join('; ')
}
