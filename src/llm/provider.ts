/**
 * Provider-agnostic LLM interface (RESEARCH §4.1).
 *
 * The concrete backend is deliberately undecided: scoring and letters are stages
 * 4-5, and the pipeline has to be runnable before that call is made. `none` is a
 * real, working provider — it refuses loudly instead of silently returning junk,
 * so a misconfigured run fails at the boundary rather than sending a blank letter.
 */

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
        'anthropic | openrouter | ollama (and export the key named by llm.apiKeyEnv).',
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
import { ClaudeCliProvider } from './claudeCli.js'

export function createProvider(cfg: Config): LlmProvider {
  switch (cfg.llm.provider) {
    case 'none':
      return new NoneProvider()

    case 'claude-cli':
      return new ClaudeCliProvider(cfg)
    // Stages 4-5 land here. Each is a thin fetch() against the provider's HTTP API;
    // nothing else in the codebase knows which one is in use.
    case 'anthropic':
    case 'openrouter':
    case 'ollama':
      throw new Error(
        `Provider "${cfg.llm.provider}" is not implemented yet (stages 4-5). ` +
          'Keep llm.provider = "none" until then.',
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
