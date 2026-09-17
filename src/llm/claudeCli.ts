import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CompletionRequest, CompletionResult, LlmProvider } from './provider.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

const run = promisify(execFile)
const log = logger('llm')

/**
 * Generate through the locally installed `claude` CLI.
 *
 * Why this exists: a Claude Code subscription is not an API key, and this machine has
 * no API credentials. The CLI, however, is installed and already authenticated, and
 * `claude -p` runs it non-interactively — so a local personal tool can use it without
 * anyone provisioning anything.
 *
 * Known cost, measured rather than assumed: each invocation re-sends Claude Code's own
 * system prompt (~9k cache-write + ~19k cache-read tokens) and takes roughly four
 * seconds, whatever the payload. That overhead is charged against the subscription's
 * usage allowance, not billed separately. At a few dozen letters a day it is
 * comfortable; at several hundred it is worth moving to the API.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli'
  readonly model: string

  constructor(private readonly cfg: Config) {
    this.model = cfg.llm.model || 'sonnet'
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const args = ['-p', req.prompt, '--output-format', 'json', '--model', this.model]

    // Letter writing needs no tools. Denying them keeps the CLI from wandering off
    // into the filesystem and trims what it has to reason about.
    args.push('--disallowed-tools', 'Bash,Read,Write,Edit,WebSearch,WebFetch')

    if (req.system) args.push('--append-system-prompt', req.system)

    const started = Date.now()
    let stdout: string
    try {
      const result = await run('claude', args, {
        timeout: this.cfg.llm.timeoutSec * 1000,
        maxBuffer: 8 * 1024 * 1024,
        // Inherit the user's environment so the CLI finds its own credentials.
        env: process.env,
      })
      stdout = result.stdout
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string }
      if (err.code === 'ENOENT') {
        throw new Error('`claude` is not on PATH — install Claude Code or switch llm.provider.')
      }
      throw new Error(`claude CLI failed: ${err.stderr?.trim() || err.message}`)
    }

    return this.parse(stdout, Date.now() - started)
  }

  /**
   * The CLI's JSON envelope carries usage and the answer. Its exact shape is not a
   * stable contract, so fall back to treating the output as plain text rather than
   * failing the whole generation on an unexpected field.
   */
  private parse(stdout: string, elapsedMs: number): CompletionResult {
    const trimmed = stdout.trim()

    try {
      const parsed = JSON.parse(trimmed) as {
        result?: string
        usage?: { input_tokens?: number; output_tokens?: number }
        total_cost_usd?: number
        is_error?: boolean
      }

      if (parsed.is_error) throw new Error(`claude CLI reported an error: ${trimmed.slice(0, 200)}`)

      const text = parsed.result
      if (typeof text !== 'string') {
        throw new Error('claude CLI JSON had no `result` field')
      }

      log.debug(
        `${this.model}: ${parsed.usage?.output_tokens ?? '?'} out tokens, ` +
          `${(elapsedMs / 1000).toFixed(1)}s` +
          (parsed.total_cost_usd ? `, $${parsed.total_cost_usd.toFixed(4)} of allowance` : ''),
      )

      return {
        text: text.trim(),
        model: this.model,
        inputTokens: parsed.usage?.input_tokens,
        outputTokens: parsed.usage?.output_tokens,
      }
    } catch (e) {
      if (trimmed.startsWith('{')) throw e
      // Not JSON at all — the CLI printed the answer directly.
      return { text: trimmed, model: this.model }
    }
  }
}
