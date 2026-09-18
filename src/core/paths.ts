import { fileURLToPath } from 'node:url'
import { dirname, relative, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))

/** Repo root. All state lives under <root>/data so nothing escapes the project. */
export const ROOT = resolve(here, '..', '..')

export const DATA_DIR = resolve(ROOT, 'data')
export const DB_PATH = resolve(DATA_DIR, 'hhh.sqlite')
export const CONFIG_PATH = resolve(ROOT, 'config.json')
export const CONFIG_EXAMPLE_PATH = resolve(ROOT, 'config.example.json')

/**
 * Persistent Chromium profile (RESEARCH §2.1). Not storageState: the profile keeps
 * localStorage/IndexedDB/fingerprint too, so hh sees one device instead of a new one
 * on every run.
 */
export const BROWSER_PROFILE_DIR = resolve(DATA_DIR, 'session', 'chromium-profile')
export const SCREENSHOT_DIR = resolve(DATA_DIR, 'screenshots')
export const PROBE_DIR = resolve(DATA_DIR, 'probe')

export function ensureDirs(): void {
  for (const d of [DATA_DIR, BROWSER_PROFILE_DIR, SCREENSHOT_DIR, PROBE_DIR]) {
    mkdirSync(d, { recursive: true })
  }
}

/**
 * A path as it is shown to a human: relative to the repo root.
 *
 * Everything this app touches lives inside the project, so the absolute prefix is
 * noise in front of the part that identifies the file. A path outside the root
 * (nothing does this today) is left absolute rather than turned into a chain of `..`.
 */
export function projectPath(p: string): string {
  const rel = relative(ROOT, p)
  return rel && !rel.startsWith('..') ? rel : p
}
