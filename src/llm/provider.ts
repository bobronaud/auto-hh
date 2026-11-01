/** Provider-agnostic completions for letters, forms, chats and images. */

export interface CompletionRequest {
  system?: string
  prompt: string
  maxTokens?: number
  temperature?: number
  /** Ask the provider for strict JSON where it supports it. */
  json?: boolean
  /** Pictures sent ahead of the prompt text (captcha reading). */
  images?: CompletionImage[]
}

export interface CompletionImage {
  mediaType: 'image/png' | 'image/jpeg'
  base64: string
}

export interface CompletionResult {
  text: string
  model: string
  inputTokens?: number
  outputTokens?: number
}

export interface LlmProvider {
  readonly name: string
  readonly model: string
  complete(req: CompletionRequest): Promise<CompletionResult>
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      'No LLM provider configured. Set llm.provider in config.json to one of: ' +
        'codex-cli (run codex login first). HTTP providers are not implemented.',
    )
    this.name = 'LlmNotConfiguredError'
  }
}

class NoneProvider implements LlmProvider {
  readonly name = 'none'
  readonly model = 'none'
  complete(): Promise<CompletionResult> {
    return Promise.reject(new LlmNotConfiguredError())
  }
}

import type { Config } from '../config/schema.js'
import { CodexCliProvider } from './codexCli.js'

export function createProvider(cfg: Config): LlmProvider {
  switch (cfg.llm.provider) {
    case 'none':
      return new NoneProvider()

    case 'codex-cli':
      return new CodexCliProvider(cfg)
    // Reserved config values; the local CLI is the implemented backend.
    case 'anthropic':
    case 'openrouter':
    case 'ollama':
      throw new Error(
        `Provider "${cfg.llm.provider}" is not implemented. ` +
          'Use llm.provider = "codex-cli" for generation.',
      )
    default: {
      const never: never = cfg.llm.provider
      throw new Error(`Unknown provider: ${String(never)}`)
    }
  }
}

export function isConfigured(cfg: Config): boolean {
  return cfg.llm.provider !== 'none'
}
