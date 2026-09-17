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
    json: true,
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
      log.warn(`letter ${t.index}: ${v.problems.map((p) => PROBLEM_LABEL[p]).join(', ')}`)
    }
    return { index: t.index, text, ok: v.ok, problems: v.problems.map((p) => PROBLEM_LABEL[p]) }
  })
}

/**
 * Pull the JSON array out of the response.
 *
 * Models wrap JSON in prose or fences no matter how firmly asked not to, so locate the
 * array by its brackets rather than trusting the whole string to parse.
 */
function parseBatch(text: string, expected: number): Map<number, string> {
  const out = new Map<number, string>()

  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) {
    log.error('LLM response contained no JSON array')
    return out
  }

  let items: unknown
  try {
    items = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    log.error(`could not parse the JSON array: ${(e as Error).message}`)
    return out
  }
  if (!Array.isArray(items)) return out

  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as { i?: unknown; letter?: unknown }
    const i = typeof rec.i === 'number' ? rec.i : Number(rec.i)
    if (!Number.isInteger(i) || typeof rec.letter !== 'string') continue
    out.set(i, rec.letter)
  }

  if (out.size !== expected) {
    log.warn(`asked for ${expected} letters, parsed ${out.size}`)
  }
  return out
}
