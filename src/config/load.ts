import { readFileSync, existsSync } from 'node:fs'
import { configSchema, type Config } from './schema.js'
import { CONFIG_PATH, CONFIG_EXAMPLE_PATH } from '../core/paths.js'

let cached: Config | null = null

export function loadConfig(force = false): Config {
  if (cached && !force) return cached

  const path = existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE_PATH
  if (!existsSync(path)) {
    throw new Error(`No config found. Copy config.example.json to config.json.`)
  }

  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid ${path}:\n${issues}`)
  }

  cached = parsed.data
  return cached
}

export function configSource(): string {
  return existsSync(CONFIG_PATH) ? CONFIG_PATH : `${CONFIG_EXAMPLE_PATH} (example — copy it to config.json)`
}
