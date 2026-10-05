import { createProvider, type LlmProvider } from '../llm/provider.js'
import { readResumeText } from '../letters/generate.js'
import { tidyLetter } from '../letters/validate.js'
import { textProblem } from '../answers/generate.js'
import { logger } from '../core/logger.js'
import { systemPrompt, chatPrompt, type ChatPromptInput } from './prompt.js'
import type { Config } from '../config/schema.js'

const log = logger('chat')

export type ChatReply =
  | { kind: 'reply'; text: string }
  /** The assistant's last message needs no answer — wait for its next one. */
  | { kind: 'no_reply' }
  /** `reason` is what the owner reads: the model's own, or what the check rejected. */
  | { kind: 'unanswered'; reason: string }

/** One model call per chat: a chat's questions arrive one at a time anyway. */
export async function answerChat(
  input: Omit<ChatPromptInput, 'resumeText'>,
  cfg: Config,
  provider: LlmProvider = createProvider(cfg),
): Promise<ChatReply> {
  let text: string
  try {
    const result = await provider.complete({
      system: systemPrompt(),
      prompt: chatPrompt({ ...input, resumeText: readResumeText(input.resume) }, cfg),
    })
    text = result.text
  } catch (e) {
    return { kind: 'unanswered', reason: `LLM не ответила: ${(e as Error).message}` }
  }
  log.debug(`chat reply, raw: ${text}`)
  return interpretReply(text)
}

export function interpretReply(raw: string): ChatReply {
  if (/###\s*НЕ\s+НУЖНО\s*###/iu.test(raw)) return { kind: 'no_reply' }

  const unknown = raw.match(/###\s*НЕ\s+ЗНАЮ\s*###([\s\S]*)/iu)
  if (unknown) return { kind: 'unanswered', reason: `модель не знает ответа — ${unknown[1]!.trim() || 'без причины'}` }

  const m = raw.match(/###\s*ОТВЕТ\s*###([\s\S]*)/iu)
  if (!m) return { kind: 'unanswered', reason: 'модель ответила не по формату' }

  const text = tidyLetter(m[1]!)
  const problem = textProblem(text)
  return problem ? { kind: 'unanswered', reason: problem } : { kind: 'reply', text }
}
