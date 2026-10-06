import type { Page } from 'playwright'
import { goto, pause, screenshot, waitOutCaptcha, HH_BASE } from './browser.js'
import { selectors, type SelectorCandidates } from './selectors.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'
import type { ChatAuthor, ChatMessage } from '../chat/classify.js'

const log = logger('chat')

/** Ceiling for the chat app to render after a navigation or a filter switch. */
const LOAD_TIMEOUT_MS = 15_000
/** Ceiling for our own message to show up after sending. */
const SEND_TIMEOUT_MS = 15_000

export interface ChatSummary {
  id: string
  title: string | null
  company: string | null
}

export interface ChatView {
  messages: ChatMessage[]
  title: string | null
  company: string | null
  vacancyHhId: string | null
}

export type SendOutcome = { ok: true } | { ok: false; reason: string; screenshot?: string }

const any = (c: SelectorCandidates) => c.join(', ')
const S = selectors.chat

/**
 * The chat list, optionally narrowed by hh's own "только непрочитанные" filter.
 * Reading the list marks nothing as read — only opening a chat does.
 */
export async function listChats(page: Page, cfg: Config, opts: { unreadOnly: boolean }): Promise<ChatSummary[]> {
  await goto(page, `${HH_BASE}/chat`, cfg)
  const toggle = page.locator(any(S.onlyUnread)).first()
  await toggle.waitFor({ state: 'attached', timeout: LOAD_TIMEOUT_MS })
  await settleList(page)

  // hh remembers the filter between visits, so it is set both ways, not only on.
  if ((await toggle.isChecked()) !== opts.unreadOnly) {
    await page.locator(any(S.onlyUnreadLabel)).first().click()
    await page.waitForFunction(
      ([sel, want]) => (document.querySelector(sel as string) as HTMLInputElement | null)?.checked === want,
      [any(S.onlyUnread), opts.unreadOnly] as const,
      { timeout: LOAD_TIMEOUT_MS },
    )
    await settleList(page)
  }

  return page.locator(any(S.listItem)).evaluateAll(
    (els, [titleSel, companySel]) =>
      els.map((el) => ({
        id: (el.getAttribute('data-qa') ?? '').replace(/^chatik-open-chat-/, ''),
        title: el.querySelector(titleSel!)?.textContent?.replace(/^\s*в архиве\s*/u, '').trim() || null,
        company: el.querySelector(companySel!)?.textContent?.trim() || null,
      })),
    [any(S.listTitle), any(S.listCompany)],
  ).then((rows) => rows.filter((r) => /^\d+$/.test(r.id)))
}

/**
 * Wait for the list to render: the first chat cell, or — for an empty filtered list —
 * the skeleton gone and the requests done. Never a timer.
 */
async function settleList(page: Page): Promise<void> {
  await page
    .locator(any(S.listSkeleton))
    .first()
    .waitFor({ state: 'hidden', timeout: LOAD_TIMEOUT_MS })
    .catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS }).catch(() => {})
  await page
    .locator(any(S.listItem))
    .first()
    .waitFor({ state: 'attached', timeout: 5000 })
    .catch(() => {})
}

/** Open one chat — this marks it read on hh — and read the whole thread. */
export async function readChat(page: Page, cfg: Config, id: string): Promise<ChatView> {
  await goto(page, `${HH_BASE}/chat/${id}`, cfg)
  await page.locator(any(S.message)).first().waitFor({ state: 'attached', timeout: LOAD_TIMEOUT_MS })
  await page.waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS }).catch(() => {})
  return readThread(page)
}

/**
 * hh's question bots, answered alike (owner, 06.10): «ИИ-помощник» and «Робот-рекрутер».
 * The hyphen may come as any dash.
 */
const BOT_AUTHOR = /ии[\s\p{Pd}]*помощник|робот[\s\p{Pd}]*рекрутер/iu

/** Parse the open chat. Separate from navigation so fixtures can test it. */
export async function readThread(page: Page): Promise<ChatView> {
  const raw = await page.locator(any(S.message)).evaluateAll(
    (els, [systemSel, bubbleSel, textSel, titleSel, authorSel, ownSel]) =>
      els.map((el) => ({
        system: el.querySelector(systemSel!)?.textContent?.trim() ?? null,
        bubble: !!el.querySelector(bubbleSel!),
        text: (el.querySelector(textSel!) as HTMLElement | null)?.innerText?.trim() ?? '',
        title: el.querySelector(titleSel!)?.textContent?.replace(/\s+/g, ' ').trim() || null,
        author: el.querySelector(authorSel!)?.textContent?.trim() || null,
        own: !!el.querySelector(ownSel!),
      })),
    [any(S.systemMessage), any(S.bubble), any(S.bubbleText), any(S.bubbleTitle), any(S.authorName), any(S.ownMark)],
  )

  // The author's name heads only the first bubble of a run; carry it forward.
  const messages: ChatMessage[] = []
  let lastForeign: string | null = null
  for (const m of raw) {
    if (m.system) {
      messages.push({ author: 'system', text: m.system })
      continue
    }
    if (!m.bubble) continue
    let author: ChatAuthor
    if (m.own) {
      author = 'me'
      lastForeign = null
    } else {
      if (m.author) lastForeign = m.author
      author = lastForeign && BOT_AUTHOR.test(lastForeign) ? 'assistant' : 'employer'
    }
    messages.push({ author, text: m.text, title: m.title })
  }

  const header = await textOf(page, S.headerVacancy)
  const href = await page.locator(any(S.vacancyLink)).first().getAttribute('href', { timeout: 1000 }).catch(() => null)
  return {
    messages,
    title: header?.replace(/^\s*Вакансия\s*/u, '').replace(/^в архиве\s*/u, '').replace(/\s*Перейти\s*$/u, '').trim() || null,
    company: await textOf(page, S.headerTitle),
    vacancyHhId: href?.match(/\/vacancy\/(\d+)/)?.[1] ?? null,
  }
}

async function textOf(page: Page, c: SelectorCandidates): Promise<string | null> {
  const loc = page.locator(any(c)).first()
  if ((await loc.count()) === 0) return null
  return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim() || null
}

/**
 * Type the reply and send it, then confirm by DOM that it landed (invariant 5).
 *
 * One line only: Enter sends in this chat, so a newline would split the reply into
 * two messages if Enter is the way it goes out.
 */
export async function sendReply(page: Page, cfg: Config, text: string): Promise<SendOutcome> {
  const line = text.replace(/\s*\n+\s*/g, ' ').trim()
  const before = await ownCount(page)

  const input = page.locator(any(S.input)).first()
  try {
    await input.waitFor({ state: 'visible', timeout: LOAD_TIMEOUT_MS })
    await input.fill(line)
  } catch (e) {
    return fail(page, `поле сообщения не найдено: ${(e as Error).message.split('\n')[0]}`)
  }

  // Enter, not the send button: hh labels the button itself «Enter — отправить
  // сообщение», and the cookie banner at the bottom of the page sits over the button,
  // so a click hangs for 30 s and takes the whole run down (06.10).
  await input.press('Enter')

  if (await waitForOwn(page, before, line)) return { ok: true }
  // A captcha can come up on send, as it does on the application modal.
  if (await waitOutCaptcha(page, cfg, 'chat-send')) {
    if ((await ownCount(page)) === before) {
      await input.fill(line).catch(() => {})
      await input.press('Enter').catch(() => {})
    }
    if (await waitForOwn(page, before, line)) return { ok: true }
  }
  return fail(page, 'своё сообщение не появилось в ленте')
}

async function ownCount(page: Page): Promise<number> {
  const view = await readThread(page)
  return view.messages.filter((m) => m.author === 'me').length
}

async function waitForOwn(page: Page, before: number, line: string): Promise<boolean> {
  const deadline = Date.now() + SEND_TIMEOUT_MS
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  while (Date.now() < deadline) {
    const own = (await readThread(page)).messages.filter((m) => m.author === 'me')
    if (own.length > before && norm(own.at(-1)!.text) === norm(line)) return true
    // Polling our own DOM, not hh — the interval is how fast we notice.
    await pause(300, 100)
  }
  return false
}

async function fail(page: Page, reason: string): Promise<SendOutcome> {
  return { ok: false, reason, screenshot: await screenshot(page, 'chat-send') }
}
