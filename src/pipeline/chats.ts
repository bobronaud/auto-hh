import { openContext, getPage, HumanNeededError, randomBetween, screenshot } from '../hh/browser.js'
import { listChats, readChat, sendReply, type ChatSummary } from '../hh/chat.js'
import { chatState } from '../chat/classify.js'
import { answerChat } from '../chat/generate.js'
import { classifyEmployerMessage } from '../chat/employer.js'
import { routeResume } from '../scoring/resumeRouter.js'
import { salaryAnswer } from '../answers/salary.js'
import { Repo } from '../db/repo.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

const log = logger('chats')

/** The owner's 15 seconds for the assistant to write its next question, randomised (invariant 8). */
const PASS_GAP_MS: [number, number] = [15_000, 18_000]
/** A run that never runs dry is a bug, not a busy inbox. */
const MAX_PASSES = 40
/** Passes a chat may sit in "we spoke last" before we stop waiting for the assistant. */
const MAX_IDLE_PASSES = 4

export interface ChatRunResult {
  passes: number
  chats: number
  answered: number
  needsHuman: number
  human: number
  /** Employer messages the model read as a mass mailing — not shown to the owner. */
  mailings: number
  finished: number
  failed: number
  stopReason?: string
}

/**
 * Answer hh's AI assistant in every chat that has a question waiting, pass after pass.
 *
 * A pass reads the "unread only" list plus every chat we answered and are still
 * waiting on. The second set matters: the assistant can reply while the chat is still
 * open on our side, which marks it read, and it would never show up as unread again.
 *
 * dryRun does not apply here (owner, 05.10): replies always go out.
 */
export async function runChats(cfg: Config): Promise<ChatRunResult> {
  const repo = new Repo()
  const result: ChatRunResult = { passes: 0, chats: 0, answered: 0, needsHuman: 0, human: 0, mailings: 0, finished: 0, failed: 0 }
  // chat id → idle passes so far, for chats where we spoke last.
  const awaiting = new Map<string, number>()
  // Chats settled this run: finished, parked or human — never reopened.
  const done = new Set<string>()
  const seen = new Set<string>()
  const known = new Map<string, ChatSummary>()

  const ctx = await openContext(cfg)
  try {
    const page = await getPage(ctx)

    while (result.passes < MAX_PASSES) {
      const unread = (await listChats(page, cfg, { unreadOnly: true })).filter((c) => !done.has(c.id))
      for (const c of unread) known.set(c.id, c)
      const ids = [...new Set([...unread.map((c) => c.id), ...awaiting.keys()])]
      if (ids.length === 0) break

      result.passes++
      log.info(`проход ${result.passes}: непрочитанных ${unread.length}, ждём ответа в ${awaiting.size}`)

      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id)
          result.chats++
        }
        const chat = await readChat(page, cfg, id)
        const summary = known.get(id)
        const title = chat.title ?? summary?.title ?? null
        const company = chat.company ?? summary?.company ?? null
        const state = chatState(chat.messages)
        const tag = `${(title ?? id).slice(0, 50)}${company ? ` · ${company}` : ''}`

        if (state.kind === 'awaiting' || (state.kind === 'question' && repo.chatQuestionHandled(id, state.question))) {
          const idle = (awaiting.get(id) ?? -1) + 1
          if (idle >= MAX_IDLE_PASSES) {
            awaiting.delete(id)
            log.info(`   ${tag}: помощник молчит ${idle} проходов — дальше не ждём`)
          } else awaiting.set(id, idle)
          continue
        }
        awaiting.delete(id)

        if (state.kind === 'finished' || state.kind === 'other') {
          done.add(id)
          if (state.kind === 'finished') {
            result.finished++
            log.info(`   ${tag}: помощник закончил`)
          } else {
            // Said out loud: a pass that answers nothing should still say what it saw.
            const lastTitle = chat.messages.filter((m) => m.author !== 'system').at(-1)?.title
            log.info(`   ${tag}: ${lastTitle ? `«${lastTitle}»` : 'нет вопросов'} — отвечать нечего`)
          }
          continue
        }

        if (state.kind === 'human') {
          done.add(id)
          if (repo.chatQuestionHandled(id, state.last)) continue
          const verdict = await classifyEmployerMessage(state.last, cfg)
          if (verdict.auto) {
            result.mailings++
            log.info(`   ${tag}: рассылка работодателя — ${verdict.reason || 'отвечать нечего'}`)
            continue
          }
          repo.recordChatReply({ chatId: id, title, company, question: state.last, status: 'human', reason: verdict.reason })
          result.human++
          log.info(`   ${tag}: пишет рекрутер — оставлено вам (${verdict.reason})`)
          continue
        }

        // A question from the assistant.
        const vacancy = chat.vacancyHhId ? repo.getVacancyByHhId(chat.vacancyHhId) : undefined
        const vTitle = vacancy?.title ?? title ?? ''
        const route = routeResume(cfg, { title: vTitle, description: vacancy?.description })
        const reply = await answerChat(
          {
            vacancy: { title: vTitle, company: vacancy?.company ?? company, description: vacancy?.description ?? null },
            salary: salaryAnswer({
              title: vTitle,
              salaryFrom: vacancy?.salary_from ?? null,
              salaryTo: vacancy?.salary_to ?? null,
              currency: vacancy?.salary_currency ?? null,
              experience: null,
            }),
            resume: route.resume,
            messages: chat.messages,
          },
          cfg,
        )
        const base = { chatId: id, vacancyId: vacancy?.id ?? null, title, company, question: state.question }
        log.info(`   ${tag}: вопрос «${short(state.question)}»`)

        if (reply.kind === 'no_reply') {
          awaiting.set(id, 0)
          continue
        }
        if (reply.kind === 'unanswered') {
          done.add(id)
          repo.recordChatReply({ ...base, status: 'needs_human', reason: reply.reason })
          result.needsHuman++
          log.warn(`   оставлено вам: ${reply.reason}`)
          continue
        }

        const sent = await sendReply(page, cfg, reply.text)
        if (sent.ok) {
          repo.recordChatReply({ ...base, answer: reply.text, status: 'sent' })
          result.answered++
          awaiting.set(id, 0)
          log.info(`   ответ: «${reply.text}»`)
        } else {
          // Not retried: the reply may have gone out after all, and a duplicate reads
          // as a bot. The owner sees the row and the screenshot.
          done.add(id)
          const shot = sent.screenshot ?? (await screenshot(page, `chat-${id}`))
          repo.recordChatReply({ ...base, answer: reply.text, status: 'failed', reason: sent.reason, screenshotPath: shot })
          result.failed++
          log.warn(`   отправка не подтвердилась: ${sent.reason}`)
        }
      }

      if (awaiting.size === 0) {
        // Nothing to wait for: one more look at the unread list catches chats whose
        // first question arrived during this pass — without the pause.
        continue
      }
      log.info(`пауза ~15 с — помощник пишет следующие вопросы`)
      await randomBetween(...PASS_GAP_MS)
    }
    if (result.passes >= MAX_PASSES) result.stopReason = 'max_passes'
  } catch (e) {
    if (!(e instanceof HumanNeededError)) throw e
    result.stopReason = e.state
    log.error(`stopping: ${e.message}`)
  } finally {
    await ctx.close()
  }
  return result
}

function short(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 100 ? `${t.slice(0, 100)}...` : t
}
