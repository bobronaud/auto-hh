import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
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
 * By default `claude -p` ships the whole Claude Code environment with every request:
 * its own system prompt, every built-in tool's description, MCP servers (claude.ai
 * connectors included), skills and the CLAUDE.md found from cwd upwards. Measured on
 * a one-word prompt: ~36k input tokens with the old flags, ~400 with the ones below.
 * `--bare` would do the same in one flag, but it ignores the subscription's OAuth and
 * only reads ANTHROPIC_API_KEY, so the pieces are switched off one by one instead.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli'
  readonly model: string

  constructor(private readonly cfg: Config) {
    this.model = cfg.llm.model || 'sonnet'
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const args = [
      '-p', req.prompt,
      '--output-format', 'json',
      '--model', this.model,
      // No built-in tools at all: their descriptions were most of the request.
      '--tools', '',
      // No MCP servers, claude.ai connectors included.
      '--strict-mcp-config',
      // No user/project/local settings: hooks and plugins have nothing to do here.
      '--setting-sources', '',
      // Replace Claude Code's own system prompt rather than appending to it.
      '--system-prompt', req.system ?? 'Отвечай строго в заданном формате.',
    ]

    const started = Date.now()
    let stdout: string
    try {
      const result = await run('claude', args, {
        timeout: this.cfg.llm.timeoutSec * 1000,
        maxBuffer: 8 * 1024 * 1024,
        // Outside the project, so its CLAUDE.md and git status stay out of the prompt.
        cwd: tmpdir(),
        // Inherit the user's environment so the CLI finds its own credentials.
        env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
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
