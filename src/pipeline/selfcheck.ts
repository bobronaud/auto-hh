import type { Page } from 'playwright'
import {
  openContext,
  getPage,
  goto,
  detectState,
  screenshot,
  dumpHtml,
  waitOutCaptcha,
  HumanNeededError,
  HH_BASE,
} from '../hh/browser.js'
import { selectors, firstMatch, firstVisibleMatch } from '../hh/selectors.js'
import { probeGroup } from '../hh/probe.js'
import { buildSearchUrl } from '../hh/searchUrl.js'
import { scrapePage, type ScrapedCard } from '../hh/search.js'
import { fetchVacancyDetails, type VacancyDetails } from '../hh/vacancyPage.js'
import { classifyApplyFlow, confirmOtherCountry } from '../hh/applyFlow.js'
import { waitForApplyFlow } from '../hh/apply.js'
import { currentResumeTitle, availableTitles, matches } from '../hh/resumePicker.js'
import { readForm, type ReadForm } from '../hh/responseForm.js'
import { listChats, readChat, type ChatSummary, type ChatView } from '../hh/chat.js'
import { Repo } from '../db/repo.js'
import { logger } from '../core/logger.js'
import { raiseAlarms } from './tripwires.js'
import type { Config } from '../config/schema.js'

const log = logger('selfcheck')

/**
 * "Does the pipeline still work against today's hh?" — the button on the dashboard.
 *
 * Not the recon probe (`selectors:probe`), which prints what exists and leaves the
 * verdict to a human. This walks the same functions the runs use and judges their
 * output: on 29.10 the chat's `message` selector still matched, and the thread still
 * parsed as empty — a selector-only check would have called that green.
 *
 * Two levels per page: the semantic verdict (the production parser returned something
 * sensible), and the required selector keys, which is what tells you where to fix it.
 * No CSS here (invariant 1): keys into selectors.ts and production calls only.
 *
 * Sends nothing. The apply check presses «Откликнуться» and reads the form, never
 * «Отправить». Writes nothing to `applications` — except when hh accepted the
 * application on the click itself, because then that is what happened on hh
 * (invariants 5 and 11). Opens only chats that are already read: opening marks read.
 */

export type CheckStatus = 'ok' | 'broken' | 'skipped'

export interface Check {
  area: 'session' | 'search' | 'vacancy' | 'apply' | 'chat' | 'captcha'
  name: string
  status: CheckStatus
  detail: string
  /** Required selector keys no candidate matched — where to look in selectors.ts. */
  missingKeys?: string[]
  dump?: string | null
  screenshot?: string | null
}

export interface SelfCheckReport {
  ok: boolean
  checkedAt: string
  checks: Check[]
}

/** Queue vacancies tried before giving up on seeing a modal and a questions form. */
const APPLY_CANDIDATES = 5

// ------------------------------------------------------------------ verdicts
// Pure, so fixtures can pin them. Each returns the problem, or null when fine.

export function judgeSearch(cards: ReadonlyArray<Pick<ScrapedCard, 'hhId' | 'title' | 'company'>>, domCards: number): string | null {
  if (domCards === 0) return 'на странице выдачи ни одной карточки'
  if (cards.length === 0) return `карточек ${domCards}, но ни одна не разобралась (нет ссылки или заголовка)`
  if (cards.length / domCards < 0.8) return `из ${domCards} карточек разобралось только ${cards.length}`
  const withCompany = cards.filter((c) => c.company).length
  if (withCompany / cards.length < 0.5) return `работодатель прочитан у ${withCompany} из ${cards.length} карточек`
  return null
}

export function judgeVacancy(d: VacancyDetails): string | null {
  if (d.archived) return null
  return d.description ? null : 'описание вакансии не прочиталось'
}

export function judgeForm(form: ReadForm): string | null {
  if (!form.ok) return `форма вопросов не разобралась: ${form.reason}`
  return form.questions.length > 0 ? null : 'в форме не найдено ни одного вопроса'
}

export function judgeChatList(list: readonly ChatSummary[]): string | null {
  if (list.length === 0) return 'список чатов пуст'
  const titled = list.filter((c) => c.title).length
  return titled / list.length < 0.8 ? `заголовок прочитан у ${titled} из ${list.length} чатов` : null
}

/** `bot`: the chat is known to hold a bot conversation (we answered one there). */
export function judgeThread(v: ChatView, opts: { bot: boolean }): string | null {
  const spoken = v.messages.filter((m) => m.author !== 'system')
  if (spoken.length === 0) return 'в ленте не распознано ни одного сообщения'
  if (!spoken.some((m) => m.author === 'me')) return 'не найдено ни одного своего сообщения (хотя бы письма)'
  if (spoken.some((m) => !m.text.trim())) return 'у части сообщений пустой текст'
  if (opts.bot && !spoken.some((m) => m.author === 'assistant')) return 'в чате с ботом не опознан ни бот, ни его автор'
  if (!v.title || !v.company) return 'не прочитана шапка чата (вакансия или работодатель)'
  if (!v.vacancyHhId) return 'не найдена ссылка на вакансию в шапке чата'
  return null
}

// --------------------------------------------------------------------- walk

export async function runSelfCheck(cfg: Config): Promise<SelfCheckReport> {
  const repo = new Repo()
  const checks: Check[] = []
  const ctx = await openContext(cfg)

  try {
    const page = await getPage(ctx)
    const add = async (c: Check, keys: KeyList = []): Promise<void> => {
      const missing = c.status === 'skipped' ? [] : [...(c.missingKeys ?? []), ...(await missingKeys(page, keys))]
      // A missing required key is broken even when the parser coped via a fallback.
      const status: CheckStatus = c.status === 'ok' && missing.length > 0 ? 'broken' : c.status
      const check: Check = { ...c, status, ...(missing.length ? { missingKeys: missing } : {}) }
      if (status === 'broken') {
        check.screenshot = await screenshot(page, `selfcheck-${c.area}`)
        check.dump = await dumpHtml(page, `selfcheck-${c.area}`)
      }
      log[status === 'broken' ? 'error' : 'info'](
        `${status === 'ok' ? '✓' : status === 'broken' ? '✗' : '–'} ${c.name}: ${check.detail}` +
          `${missing.length ? ` · не найдено: ${missing.join(', ')}` : ''}`,
      )
      checks.push(check)
    }

    try {
      if (!(await checkSession(page, cfg, add))) return finish(repo, checks)
      const cards = await checkSearch(page, cfg, add)
      await checkVacancy(page, cfg, cards, add)
      await checkApply(page, cfg, repo, cards, add)
      await checkChats(page, cfg, repo, add)
    } catch (e) {
      if (!(e instanceof HumanNeededError)) throw e
      // A captcha or a lost session mid-check: not a selector verdict either way.
      await add({ area: 'session', name: 'сессия', status: 'broken', detail: `проверка прервана: ${e.state}` })
    }
    checks.push({
      area: 'captcha',
      name: 'капча',
      status: 'skipped',
      detail: 'вживую не вызвать — разметка покрыта test/captcha.test.ts на фикстуре',
    })
    return finish(repo, checks)
  } finally {
    await ctx.close()
  }
}

type KeyList = ReadonlyArray<[keyof typeof selectors, string]>
/** Record a check; `keys` are verified on the page as it is right now. */
type Add = (c: Check, keys?: KeyList) => Promise<void>

function finish(repo: Repo, checks: Check[]): SelfCheckReport {
  const broken = checks.filter((c) => c.status === 'broken')
  const report: SelfCheckReport = { ok: broken.length === 0, checkedAt: new Date().toISOString(), checks }
  repo.recordSelfCheck(report.ok, report)
  if (report.ok) {
    const closed = repo.resolveAlarms()
    if (closed) log.info(`закрыто тревог: ${closed}`)
  } else {
    raiseAlarms(
      repo,
      log,
      'selfcheck',
      broken.map((c) => `проверка: ${c.name} — ${c.detail}${c.missingKeys?.length ? ` (${c.missingKeys.join(', ')})` : ''}`),
    )
  }
  log.info(report.ok ? 'селекторы в порядке' : `сломано: ${broken.length}`)
  return report
}

/** Required keys whose every candidate came up empty on the current page. */
async function missingKeys(page: Page, keys: KeyList): Promise<string[]> {
  const out: string[] = []
  for (const [group, key] of keys) {
    const candidates = (selectors[group] as unknown as Record<string, readonly string[]>)[key]
    if (!candidates) {
      out.push(`${group}.${key} (нет такого ключа)`)
      continue
    }
    const r = await probeGroup(page, group, key, candidates)
    if (r.status === 'missing') out.push(`${group}.${key}`)
  }
  return out
}

async function checkSession(page: Page, cfg: Config, add: Add): Promise<boolean> {
  await goto(page, `${HH_BASE}/applicant/negotiations`, cfg)
  const state = await detectState(page)
  const ok = state === 'logged_in'
  await add(
    { area: 'session', name: 'сессия', status: ok ? 'ok' : 'broken', detail: ok ? 'вход выполнен' : `состояние страницы: ${state} — npm run login` },
    ok ? [['auth', 'loggedIn']] : [],
  )
  return ok
}

async function checkSearch(page: Page, cfg: Config, add: Add): Promise<ScrapedCard[]> {
  await goto(page, buildSearchUrl(cfg.search, 0), cfg)
  const [first, ...rest] = selectors.search.card.map((s) => page.locator(s))
  await rest.reduce((acc, l) => acc.or(l), first!).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  const { cards, domCards } = await scrapePage(page)
  const problem = judgeSearch(cards, domCards)
  const keys: [keyof typeof selectors, string][] = [
    ['search', 'card'],
    ['search', 'cardTitleLink'],
    ['search', 'cardCompany'],
    ['search', 'cardArea'],
    ['search', 'cardApplyButton'],
  ]
  // A full page has more pages after it; the pager is how the walk finds them.
  if (cards.length >= 50) keys.push(['search', 'pagerPage'])
  await add(
    {
      area: 'search',
      name: 'выдача',
      status: problem ? 'broken' : 'ok',
      detail: problem ?? `${cards.length} карточек, у ${cards.filter((c) => c.company).length} есть работодатель`,
    },
    keys,
  )
  return cards
}

async function checkVacancy(page: Page, cfg: Config, cards: ScrapedCard[], add: Add): Promise<void> {
  const card = cards.find((c) => c.canApplyFromList && !c.alreadyAppliedOnHh) ?? cards[0]
  if (!card) {
    await add({ area: 'vacancy', name: 'страница вакансии', status: 'skipped', detail: 'выдача пуста — открыть нечего' })
    return
  }
  const details = await fetchVacancyDetails(page, card.url, cfg)
  const problem = judgeVacancy(details)
  await add(
    {
      area: 'vacancy',
      name: 'страница вакансии',
      status: problem ? 'broken' : 'ok',
      detail: problem ?? `${card.hhId}: описание ${details.description?.length ?? 0} знаков`,
    },
    details.archived
      ? []
      : [
          ['vacancy', 'title'],
          ['vacancy', 'company'],
          ['vacancy', 'description'],
          ['vacancy', 'experience'],
          ...(card.alreadyAppliedOnHh ? [] : ([['vacancy', 'applyButton']] as KeyList)),
        ],
  )
}

async function checkApply(page: Page, cfg: Config, repo: Repo, cards: ScrapedCard[], add: Add): Promise<void> {
  // The queue first: those are the vacancies the next run opens. An empty queue falls
  // back to the search page just read — pressing «Откликнуться» sends nothing, and the
  // form is the same form. Not stored unless hh takes the application on the click.
  const applied = repo.appliedHhIds()
  const fromSearch = cards
    .filter((c) => c.canApplyFromList && !c.alreadyAppliedOnHh && !applied.has(c.hhId))
    .map((c) => ({ url: c.url, hhId: c.hhId, vacancyId: () => repo.upsertVacancy(c) }))
  const queue = [
    ...repo.pendingVacancies(APPLY_CANDIDATES * 2).map((v) => ({ url: v.url, hhId: v.hh_id, vacancyId: () => v.id })),
    ...fromSearch,
  ]
  if (queue.length === 0) {
    await add({ area: 'apply', name: 'модалка отклика', status: 'skipped', detail: 'ни в очереди, ни в выдаче нет вакансии, на которую можно откликнуться' })
    await add({ area: 'apply', name: 'форма вопросов', status: 'skipped', detail: 'не на чем проверить' })
    return
  }

  let modal = false
  let questions = false
  let noButton = 0
  let unrecognised = 0
  let tried = 0

  for (const v of queue) {
    if ((modal && questions) || tried >= APPLY_CANDIDATES) break
    await goto(page, v.url, cfg)
    if (await firstVisibleMatch(page, selectors.vacancy.archived)) continue
    if (await firstVisibleMatch(page, selectors.vacancy.alreadyApplied)) continue
    tried++

    const applySel = await firstMatch(page, selectors.vacancy.applyButton)
    if (!applySel) {
      noButton++
      continue
    }
    await page.locator(applySel).first().click()
    await waitForApplyFlow(page)
    await waitOutCaptcha(page, cfg, 'selfcheck-apply')
    if (await confirmOtherCountry(page)) await waitForApplyFlow(page, { afterConfirm: true })

    // hh took the application on the click itself. That is a fact on hh, so it is
    // recorded like a run would (invariant 5); anything else is never written.
    if (await firstVisibleMatch(page, selectors.apply.success)) {
      const shot = await screenshot(page, 'selfcheck-applied-on-click')
      repo.recordApplication({ vacancyId: v.vacancyId(), status: 'applied', screenshotPath: shot })
      log.warn(`   ${v.hhId}: hh принял отклик прямо на клике — записан как applied`)
      continue
    }

    const flow = await classifyApplyFlow(page)
    log.info(`   ${v.hhId}: ${flow.kind}${'reason' in flow ? ` (${flow.reason})` : ''}`)

    if (flow.kind === 'modal' && !modal) {
      modal = true
      // Keys first, while the modal is as hh opened it: the inspection below opens the
      // dropdown and the letter field, and the page no longer looks like that.
      const missing = await missingKeys(page, [
        ['apply', 'modal'],
        ['apply', 'resumeSelect'],
        ['apply', 'resumeTitle'],
      ])
      const check = await inspectModal(page, cfg)
      await add({ ...check, ...(missing.length ? { missingKeys: missing } : {}) })
    } else if (flow.kind === 'questions' && !questions) {
      const problem = judgeForm(await readForm(page))
      const form: Check = {
        area: 'apply',
        name: 'форма вопросов',
        status: problem ? 'broken' : 'ok',
        detail: problem ?? `вопросы прочитаны (${v.hhId})`,
      }
      await add(form, [['responseForm', 'question'], ['responseForm', 'questionText'], ['apply', 'submitButton']])
      questions = true
    } else if (
      (flow.kind === 'needs_human' && flow.reason === 'unrecognised_form') ||
      (flow.kind === 'blocked' && flow.reason === 'unknown')
    ) {
      unrecognised++
    }
    // Leave the form as it is: nothing filled is submitted by walking away.
    await page.keyboard.press('Escape').catch(() => {})
  }

  if (!modal) {
    const suspect = noButton + unrecognised
    await add({
      area: 'apply',
      name: 'модалка отклика',
      status: suspect > 0 && suspect === tried ? 'broken' : 'skipped',
      detail:
        suspect > 0 && suspect === tried
          ? `из ${tried} вакансий: без кнопки «Откликнуться» ${noButton}, флоу не распознан ${unrecognised}`
          : `не встретилась среди ${tried} вакансий`,
    })
  }
  if (!questions) {
    await add({ area: 'apply', name: 'форма вопросов', status: 'skipped', detail: `не встретилась среди ${tried} вакансий` })
  }
}

/**
 * Inside an open modal: the resume picker lists every configured resume, and the
 * letter field appears. Keys are checked by the caller only on failure — on success
 * the page has already moved on (dropdown closed, letter toggled).
 */
async function inspectModal(page: Page, cfg: Config): Promise<Check> {
  const base = { area: 'apply' as const, name: 'модалка отклика' }
  const shown = await currentResumeTitle(page)
  if (!shown) return { ...base, status: 'broken', detail: 'в модалке не найден выбор резюме' }

  const trigger = await firstMatch(page, selectors.apply.resumeSelect)
  await page.locator(trigger!).first().click()
  await page.locator(selectors.apply.resumeOption[0]!).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const titles = await availableTitles(page)
  await page.keyboard.press('Escape').catch(() => {})
  if (titles.length === 0) return { ...base, status: 'broken', detail: 'список резюме открылся пустым (selectors.apply.resumeOption)' }
  // The same comparison selectResume makes: a title it would not find is a broken run.
  const missing = cfg.resumes.filter((r) => !titles.some((t) => matches(t, r.title)))
  if (missing.length) {
    return {
      ...base,
      status: 'broken',
      detail: `в списке hh нет резюме ${missing.map((r) => `«${r.title}»`).join(', ')}; есть: ${titles.map((t) => `«${t}»`).join(', ')}`,
    }
  }

  if (!(await firstMatch(page, selectors.apply.letterTextarea))) {
    const toggle = await firstMatch(page, selectors.apply.letterToggle)
    if (!toggle) return { ...base, status: 'broken', detail: 'нет ни поля письма, ни переключателя (selectors.apply.letterToggle)' }
    await page.locator(toggle).first().click()
    await page.locator(selectors.apply.letterTextarea.join(', ')).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  }
  if (!(await firstMatch(page, selectors.apply.letterTextarea))) {
    return { ...base, status: 'broken', detail: 'поле письма не появилось (selectors.apply.letterTextarea)' }
  }
  if (!(await firstMatch(page, selectors.apply.submitButton))) {
    return { ...base, status: 'broken', detail: 'нет кнопки отправки (selectors.apply.submitButton)' }
  }
  return { ...base, status: 'ok', detail: `резюме: ${titles.length}, все из конфига на месте; поле письма и кнопка отправки есть` }
}

async function checkChats(page: Page, cfg: Config, repo: Repo, add: Add): Promise<void> {
  // Unread chats are never opened here: opening marks them read, and the chat run
  // would then never see them.
  const unread = new Set((await listChats(page, cfg, { unreadOnly: true })).map((c) => c.id))
  const all = await listChats(page, cfg, { unreadOnly: false })
  const listProblem = judgeChatList(all)
  await add(
    {
      area: 'chat',
      name: 'список чатов',
      status: listProblem ? 'broken' : 'ok',
      detail: listProblem ?? `${all.length} чатов в списке, непрочитанных ${unread.size}`,
    },
    [['chat', 'onlyUnread'], ['chat', 'listItem'], ['chat', 'listTitle'], ['chat', 'listCompany']],
  )

  const bots = repo.recentBotChats(10).filter((id) => !unread.has(id))
  const id = bots[0] ?? all.find((c) => !unread.has(c.id))?.id
  if (!id) {
    await add({ area: 'chat', name: 'лента чата', status: 'skipped', detail: 'нет прочитанного чата, который можно открыть' })
    return
  }
  const bot = bots[0] === id
  const view = await readChat(page, cfg, id)
  const problem = judgeThread(view, { bot })
  await add(
    {
      area: 'chat',
      name: 'лента чата',
      status: problem ? 'broken' : 'ok',
      detail:
        problem ??
        `${id}${bot ? ' (с ботом)' : ''}: ${view.messages.length} сообщений, ` +
          `${[...new Set(view.messages.map((m) => m.author))].join('/')}`,
    },
    [
      ['chat', 'message'],
      ['chat', 'bubble'],
      ['chat', 'bubbleText'],
      ['chat', 'ownMark'],
      ['chat', 'headerTitle'],
      ['chat', 'headerVacancy'],
      ['chat', 'input'],
      ...(bot ? ([['chat', 'authorName'], ['chat', 'systemMessage']] as KeyList) : []),
    ],
  )
}

export function printSelfCheck(r: SelfCheckReport): void {
  console.log(`\n=== ПРОВЕРКА СЕЛЕКТОРОВ: ${r.ok ? 'всё работает' : 'есть поломки'} ===\n`)
  for (const c of r.checks) {
    const mark = c.status === 'ok' ? '✓' : c.status === 'broken' ? '✗' : '–'
    console.log(`  ${mark} ${c.name}: ${c.detail}`)
    if (c.missingKeys?.length) console.log(`      не найдено: ${c.missingKeys.join(', ')}`)
    if (c.dump) console.log(`      html: ${c.dump}`)
    if (c.screenshot) console.log(`      скриншот: ${c.screenshot}`)
  }
  console.log()
}
