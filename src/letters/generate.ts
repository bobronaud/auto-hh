import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProvider, type LlmProvider } from '../llm/provider.js'
import { systemPrompt, batchPrompt, PROMPT_VERSION, type LetterTarget } from './prompt.js'
import { validateLetter, tidyLetter, PROBLEM_LABEL } from './validate.js'
import { ROOT } from '../core/paths.js'
import { logger } from '../core/logger.js'
import type { Config, ResumeConfig } from '../config/schema.js'

const log = logger('letters')

export interface GeneratedLetter {
  index: number
  text: string
  ok: boolean
  problems: string[]
}

export class ResumeFileMissingError extends Error {
  constructor(resume: ResumeConfig, path: string) {
    super(
      `Resume file for "${resume.id}" not found: ${path}. ` +
        'Write your resume there as plain text — it is what the letters are built from.',
    )
    this.name = 'ResumeFileMissingError'
  }
}

export function readResumeText(resume: ResumeConfig): string {
  const path = resolve(ROOT, resume.file || `resume.${resume.id}.md`)
  if (!existsSync(path)) throw new ResumeFileMissingError(resume, path)
  const text = readFileSync(path, 'utf8').trim()
  if (text.length < 50) throw new Error(`Resume file ${path} is essentially empty.`)
  return text
}

/**
 * Generate letters for a batch of vacancies in a single LLM call.
 *
 * Batching is the whole point: measured against the claude-cli provider, ten letters
 * in one call cost $0.0017 each versus $0.041 one at a time, because every invocation
 * re-sends Claude Code's system prompt regardless of payload.
 */
export async function generateLetters(
  targets: readonly LetterTarget[],
  resume: ResumeConfig,
  cfg: Config,
  provider: LlmProvider = createProvider(cfg),
): Promise<GeneratedLetter[]> {
  if (targets.length === 0) return []

  const resumeText = readResumeText(resume)

  const result = await provider.complete({
    system: systemPrompt(cfg),
    prompt: batchPrompt(targets, resume, resumeText, cfg),
  })

  const parsed = parseBatch(result.text, targets.length)

  return targets.map((t) => {
    const raw = parsed.get(t.index)
    if (!raw) {
      return { index: t.index, text: '', ok: false, problems: ['не сгенерировано'] }
    }
    const text = tidyLetter(raw)
    const v = validateLetter(text, cfg)
    if (!v.ok) {
      // The offending fragment goes in the message, not just the verdict: the letter
      // itself is never stored, so a rejection without it cannot be checked afterwards.
      log.warn(
        `letter ${t.index}: ${v.problems
          .map((p) => (v.matched[p] ? `${PROBLEM_LABEL[p]} — «${v.matched[p]}»` : PROBLEM_LABEL[p]))
          .join('; ')}`,
      )
      log.debug(`letter ${t.index} rejected, full text: ${text}`)
    }
    return { index: t.index, text, ok: v.ok, problems: v.problems.map((p) => PROBLEM_LABEL[p]) }
  })
}

/**
 * Split the response on the letter delimiters.
 *
 * Deliberately forgiving about everything except the delimiter itself: the model may
 * add a preamble, vary the spacing, or wrap the whole thing in a code fence, and none
 * of that should cost a batch of letters.
 */
function parseBatch(text: string, expected: number): Map<number, string> {
  const out = new Map<number, string>()

  // ###ПИСЬМО 3### with any spacing, optionally fenced or bolded by the model.
  const pattern = /#{2,}\s*ПИСЬМО\s*(\d+)\s*#{2,}/gi
  const marks: Array<{ index: number; at: number; end: number }> = []

  for (const m of text.matchAll(pattern)) {
    const n = Number(m[1])
    if (Number.isInteger(n)) marks.push({ index: n, at: m.index!, end: m.index! + m[0].length })
  }

  if (marks.length === 0) {
    // A single expected letter needs no delimiter to be unambiguous.
    if (expected === 1 && text.trim()) {
      out.set(1, stripFences(text))
      return out
    }
    log.error('response contained no letter delimiters')
    return out
  }

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!
    const until = i + 1 < marks.length ? marks[i + 1]!.at : text.length
    const body = stripFences(text.slice(mark.end, until))
    if (body) out.set(mark.index, body)
  }

  if (out.size !== expected) {
    log.warn(`asked for ${expected} letters, parsed ${out.size}`)
  }
  return out
}

function stripFences(s: string): string {
  return s
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}
