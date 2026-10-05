/**
 * What a chat needs from us, decided from its messages alone — no browser here, so
 * every rule is testable on fixtures.
 *
 * Only hh's AI assistant is answered (owner, 05.10). A chat where a live recruiter
 * spoke last is left to the owner: inviting to an interview or asking for something is
 * a conversation, not a questionnaire.
 */

export type ChatAuthor = 'me' | 'assistant' | 'employer' | 'system'

export interface ChatMessage {
  author: ChatAuthor
  text: string
  /** hh's bubble heading: «Отклик на вакансию», «Отказ», «Приглашение». */
  title?: string | null
}

export type ChatState =
  /** The assistant asked and we have not answered. `question` is its trailing run of messages. */
  | { kind: 'question'; question: string }
  /** We spoke last — the assistant is composing the next question, or is done. */
  | { kind: 'awaiting' }
  /** The assistant summed up or left. */
  | { kind: 'finished' }
  /** A live recruiter spoke last. */
  | { kind: 'human'; last: string }
  /** Nobody but us: just the cover letter, a chat without the assistant. */
  | { kind: 'other' }

// The assistant's closing turns. The summary comes first and the "thanks" right after
// it, then the system line about leaving; a pass can land between any two of them.
const LEFT = /покинул[аи]?\s+чат/iu
const CLOSING = /в\s+разговоре\s+с\s+кандидатом\s+я\s+узнал|благодарю\s+за\s+ответы/iu

export function chatState(messages: readonly ChatMessage[]): ChatState {
  const spoken = messages.filter((m) => m.author !== 'system')
  const last = spoken.at(-1)
  if (!last) return { kind: 'other' }

  // Only worth waiting on when the assistant is in the chat; a bare cover letter has
  // nobody to answer it but the employer.
  if (last.author === 'me') {
    return spoken.some((m) => m.author === 'assistant') ? { kind: 'awaiting' } : { kind: 'other' }
  }
  if (last.author === 'employer') {
    // A rejection asks nothing of anyone; the owner does not need it in his queue.
    if (/отказ/iu.test(last.title ?? '')) return { kind: 'other' }
    return { kind: 'human', last: last.text }
  }

  // The assistant spoke last. Did it leave after that, or was it the closing turn?
  const lastIdx = messages.lastIndexOf(last)
  if (messages.slice(lastIdx + 1).some((m) => m.author === 'system' && LEFT.test(m.text))) {
    return { kind: 'finished' }
  }

  const trailing: string[] = []
  for (let i = spoken.length - 1; i >= 0 && spoken[i]!.author === 'assistant'; i--) {
    trailing.unshift(spoken[i]!.text)
  }
  if (trailing.some((t) => CLOSING.test(t))) return { kind: 'finished' }

  return { kind: 'question', question: trailing.join('\n\n').trim() }
}
