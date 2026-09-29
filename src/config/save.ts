import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { configSchema } from './schema.js'
import { loadConfig } from './load.js'
import { CONFIG_PATH, CONFIG_EXAMPLE_PATH } from '../core/paths.js'

/**
 * Write one setting back into config.json.
 *
 * The UI is allowed to touch a short list of settings, and every one of them goes
 * through here. Everything else stays a file edit: the point of a single validated
 * config is lost the moment two places can rewrite it.
 *
 * Three things this deliberately does:
 *
 *  - validates with `configSchema`, the same schema the CLI loads with, so the UI can
 *    never leave behind a file the CLI then refuses to start on;
 *  - writes back the user's own object with one key changed, NOT the parsed result —
 *    parsing fills in every default, which would freeze today's defaults into the file
 *    and bury the handful of settings the owner actually chose;
 *  - renames a temp file into place, so an interrupted write cannot truncate the
 *    config into something unparseable.
 */
function patchConfig(mutate: (raw: Record<string, unknown>) => Record<string, unknown>): void {
  // With no config.json yet, the example is what has been running — seed from it and
  // write a real config.json rather than editing the example in place.
  const source = existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE_PATH
  if (!existsSync(source)) throw new Error('No config found. Copy config.example.json to config.json.')

  const raw = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>
  const next = mutate(raw)

  const parsed = configSchema.safeParse(next)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Refusing to write an invalid config:\n${issues}`)
  }

  const tmp = `${CONFIG_PATH}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, CONFIG_PATH)

  loadConfig(true)
}

/** The master safety switch. */
export function setDryRun(dryRun: boolean): boolean {
  patchConfig((raw) => ({ ...raw, dryRun }))
  return dryRun
}

/**
 * The cover letter: which mode applications use, and the static text itself.
 *
 * Both live here because the two are one decision in the UI — a mode switch with the
 * text under it. Only the keys passed are touched; the rest of the letter block
 * (lengths, salary table, batch size) stays a file edit.
 *
 * The cap is hh's own 10000, measured off the field's counter, not `letter.maxChars`:
 * maxChars is the project's own "nobody reads this" line for generated letters, and
 * refusing to save a text the site would accept is not this function's call.
 */
export function setLetter(patch: { mode?: 'static' | 'llm'; text?: string }): { mode?: string; text?: string } {
  const text = patch.text?.trim()
  if (patch.text !== undefined && !text) throw new Error('Letter text cannot be empty')
  if (text && text.length > 10_000) throw new Error(`hh accepts 10000 characters, this is ${text.length}`)

  const next = {
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(text ? { text } : {}),
  }
  patchConfig((raw) => ({
    ...raw,
    letter: { ...((raw.letter as Record<string, unknown>) ?? {}), ...next },
  }))
  return next
}
