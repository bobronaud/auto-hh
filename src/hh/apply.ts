import type { Page } from 'playwright'
import { selectors, firstMatch, firstVisibleMatch } from './selectors.js'
import { classifyApplyFlow, confirmOtherCountry, type NeedsHumanReason } from './applyFlow.js'
import { selectResume } from './resumePicker.js'
import { readForm, fillForm, FormFillError } from './responseForm.js'
import { goto, screenshot, pause, randomBetween, waitOutCaptcha, dumpHtml } from './browser.js'
import { parseSalary } from './search.js'
import { answerForm, describeAnswer } from '../answers/generate.js'
import { salaryAnswer } from '../answers/salary.js'
import { logger } from '../core/logger.js'
import type { Config, ResumeConfig } from '../config/schema.js'

const log = logger('apply')

/** What was put into an employer's form — kept so a dry run can be read afterwards. */
export interface StoredAnswer {
  question: string
  kind: string
  answer: string
}

export type ApplyOutcome =
  | { status: 'applied'; resumeId: string; screenshot?: string; answers?: StoredAnswer[] }
  | { status: 'dry_run'; resumeId: string; screenshot?: string; answers?: StoredAnswer[] }
  | { status: 'needs_human'; reason: NeedsHumanReason; detail?: string; screenshot?: string }
  | { status: 'skipped'; reason: 'already_applied' | 'archived' | 'no_apply_button' }
  | { status: 'failed'; errorCode: string; message: string; screenshot?: string; answers?: StoredAnswer[] }
  | { status: 'blocked'; errorCode: 'limit_exceeded'; screenshot?: string }

export interface ApplyInput {
  url: string
  resume: ResumeConfig
  letter?: string | null
  /** What the form answers are built from. Description may be missing. */
  vacancy: { title: string; company: string | null; description: string | null }
}

/** Read off the vacancy page before "Откликнуться" — the response page has neither. */
interface PageFacts {
  experience: string | null
  salary: { from: number | null; to: number | null; currency: string | null }
}

/**
 * Answer one vacancy.
 *
 * The whole function is written so that `dryRun` exercises every step except the last
 * click: same navigation, same resume selection, same letter typed into the same
 * field. A dry run that skipped the hard parts would prove nothing.
 */
export async function applyToVacancy(
  page: Page,
  cfg: Config,
  input: ApplyInput,
): Promise<ApplyOutcome> {
  await goto(page, input.url, cfg)
  await randomBetween(cfg.limits.readPauseMsMin, cfg.limits.readPauseMsMax)

  if (await firstVisibleMatch(page, selectors.vacancy.archived)) {
    return { status: 'skipped', reason: 'archived' }
  }
  if (await firstVisibleMatch(page, selectors.vacancy.alreadyApplied)) {
    return { status: 'skipped', reason: 'already_applied' }
  }

  const applySel = await firstMatch(page, selectors.vacancy.applyButton)
  if (!applySel) return { status: 'skipped', reason: 'no_apply_button' }

  const facts = await readPageFacts(page)

  await page.locator(applySel).first().click()
  await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)

  // hh can answer the apply click with a captcha instead of a form. Checked here and
  // again after submit: both are mid-flow, without a navigation, so goto()'s state
  // check never sees them. The human types it in the open window; then the click has
  // to be repeated, because the one that raised the captcha never opened anything.
  if (await waitOutCaptcha(page, cfg, 'apply-click')) {
    const opened = (await firstMatch(page, selectors.apply.modal)) !== null
    if (!opened && !/\/applicant\/vacancy_response/.test(page.url())) {
      try {
        await page.locator(applySel).first().click()
        await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
      } catch (e) {
        log.warn(`   не удалось повторить клик после капчи: ${(e as Error).message}`)
      }
    }
  }

  // Предупреждение о вакансии в другой стране стоит ПЕРЕД формой отклика и формой
  // не является. Подтверждаем и ждём то, что откроется следом.
  if (await confirmOtherCountry(page)) {
    await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
  }

  const flow = await classifyApplyFlow(page)

  if (flow.kind === 'already_applied') return { status: 'skipped', reason: 'already_applied' }

  if (flow.kind === 'questions') return applyWithQuestions(page, cfg, input, facts)

  if (flow.kind === 'needs_human') {
    const shot = await screenshot(page, `needs-human-${flow.reason}`)
    return { status: 'needs_human', reason: flow.reason, screenshot: shot }
  }

  if (flow.kind === 'blocked') {
    const shot = await screenshot(page, `blocked-${flow.reason}`)
    if (flow.reason === 'limit_exceeded') {
      return { status: 'blocked', errorCode: 'limit_exceeded', screenshot: shot }
    }
    return {
      status: 'failed',
      errorCode: 'unknown_state',
      message: flow.detail ?? 'apply click produced no recognisable result',
      screenshot: shot,
    }
  }

  // --- Modal flow ---------------------------------------------------------

  try {
    await selectResume(page, input.resume)
  } catch (e) {
    const shot = await screenshot(page, 'resume-select-failed')
    return {
      status: 'failed',
      errorCode: 'resume_select_failed',
      message: (e as Error).message,
      screenshot: shot,
    }
  }
  await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)

  if (input.letter) {
    const wrote = await writeLetter(page, cfg, input.letter)
    if (!wrote.ok) {
      const shot = await screenshot(page, 'letter-failed')
      return { status: 'failed', errorCode: wrote.errorCode, message: wrote.message, screenshot: shot }
    }
  }

  return finish(page, cfg, input)
}

/**
 * Everything after the form is filled, shared by both flows: the dry-run stop, submit,
 * the captcha that may answer it, and the confirmation by DOM.
 *
 * `quick` is the questions flow (owner, 05.10: no human-like pauses there): instead of
 * a timer after submit it waits for the success notice itself, up to a ceiling.
 */
async function finish(
  page: Page,
  cfg: Config,
  input: ApplyInput,
  extra: { answers?: StoredAnswer[]; quick?: boolean } = {},
): Promise<ApplyOutcome> {
  const { answers, quick = false } = extra

  if (cfg.dryRun) {
    const shot = await screenshot(page, `dry-run-${input.resume.id}`, quick)
    log.info(`DRY RUN — everything ready, submit NOT clicked (${input.resume.id})`)
    return { status: 'dry_run', resumeId: input.resume.id, screenshot: shot, answers }
  }

  const submitSel = await firstMatch(page, selectors.apply.submitButton)
  if (!submitSel) {
    const shot = await screenshot(page, 'no-submit-button', quick)
    return {
      status: 'failed',
      errorCode: 'no_submit_button',
      message: 'apply form had no submit button',
      screenshot: shot,
      answers,
    }
  }

  await page.locator(submitSel).first().click()
  if (quick) await waitForSuccess(page)
  else await pause(cfg.limits.delayMs + 1500, cfg.limits.delayJitterMs)

  // Before asking whether it worked, ask whether hh is still talking to us. A captcha
  // here means the application did NOT go out, and the next vacancy would hit the same
  // wall — 63 of them did on 22.09, each written off as no_success_confirmation.
  if (await waitOutCaptcha(page, cfg, 'submit')) {
    if (!(await firstVisibleMatch(page, selectors.apply.success))) {
      // The captcha ate the click. Pressing submit once more finishes THAT
      // application rather than retrying a failed one, so invariant 7 is intact: if
      // it did go out, hh answers "вы уже откликались", which costs nothing next to
      // losing the vacancy.
      const again = await firstVisibleMatch(page, selectors.apply.submitButton)
      if (again) {
        log.info('   дожимаем отправку после капчи')
        await page.locator(again).first().click()
        if (quick) await waitForSuccess(page)
        else await pause(cfg.limits.delayMs + 1500, cfg.limits.delayJitterMs)
        await waitOutCaptcha(page, cfg, 'submit-retry')
      }
    }
  }

  // Confirm rather than assume. Without positive evidence the application is NOT
  // recorded as sent — a false 'applied' would both skip a real vacancy forever and
  // consume a slot in the rolling window that hh never actually counted.
  const ok = await firstVisibleMatch(page, selectors.apply.success)
  const shot = await screenshot(page, `applied-${input.resume.id}`, quick)

  if (!ok) {
    if (await firstVisibleMatch(page, selectors.apply.limitExceeded)) {
      return { status: 'blocked', errorCode: 'limit_exceeded', screenshot: shot }
    }
    if (await firstVisibleMatch(page, selectors.apply.tooLongMessage)) {
      return {
        status: 'failed',
        errorCode: 'too_long_message',
        message: `letter of ${input.letter?.length ?? 0} chars was rejected as too long`,
        screenshot: shot,
        answers,
      }
    }
    // Unknown shape: keep the markup too. The screenshot showed a captcha dialog that
    // no selector knew about, and without the HTML there was nothing to fix it from.
    const dump = await dumpHtml(page, 'no-success-confirmation')
    log.warn(`no confirmation — screenshot ${shot}${dump ? `, html ${dump}` : ''}`)
    return {
      status: 'failed',
      errorCode: 'no_success_confirmation',
      message: 'submitted but hh showed no confirmation — check the screenshot',
      screenshot: shot,
      answers,
    }
  }

  return { status: 'applied', resumeId: input.resume.id, screenshot: shot, answers }
}

/** Wait for any success candidate to become visible — a DOM state, not a timer. */
async function waitForSuccess(page: Page, timeoutMs = 15_000): Promise<void> {
  const [first, ...rest] = selectors.apply.success.map((s) => page.locator(s))
  const any = rest.reduce((acc, l) => acc.or(l), first!)
  await any.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {})
}

async function readPageFacts(page: Page): Promise<PageFacts> {
  const text = async (candidates: readonly string[]) => {
    const sel = await firstMatch(page, candidates)
    return sel ? await page.locator(sel).first().innerText().catch(() => null) : null
  }
  return {
    experience: await text(selectors.vacancy.experience),
    salary: parseSalary(await text(selectors.vacancy.salary)),
  }
}

/**
 * The employer-questions flow: read the form, have the model answer all of it, fill
 * it in and send — with no deliberate pauses between the steps (owner, 05.10).
 *
 * A form that cannot be answered in full is parked as form_unanswered with the reason
 * in the record and the log: a half-filled form is never sent.
 */
async function applyWithQuestions(
  page: Page,
  cfg: Config,
  input: ApplyInput,
  facts: PageFacts,
): Promise<ApplyOutcome> {
  const park = async (detail: string): Promise<ApplyOutcome> => {
    log.warn(`   форма отложена: ${detail}`)
    const shot = await screenshot(page, 'needs-human-form_unanswered', true)
    await dumpHtml(page, 'needs-human-form_unanswered')
    return { status: 'needs_human', reason: 'form_unanswered', detail, screenshot: shot }
  }

  const form = await readForm(page)
  if (!form.ok) return park(form.reason)
  const { questions } = form

  const salary = salaryAnswer({
    title: input.vacancy.title,
    salaryFrom: facts.salary.from,
    salaryTo: facts.salary.to,
    currency: facts.salary.currency,
    experience: facts.experience,
  })
  log.info(`   форма: ${questions.length} вопросов · опыт «${facts.experience ?? '?'}» · зарплата ${salary}`)

  const result = await answerForm(
    { vacancy: input.vacancy, salary, questions, resume: input.resume },
    cfg,
  )
  if (!result.ok) return park(result.reason)

  const answers: StoredAnswer[] = questions.map((q) => ({
    question: q.text,
    kind: q.kind,
    answer: describeAnswer(q, result.answers.get(q.index)!),
  }))
  for (const [i, a] of answers.entries()) {
    log.info(`   ${i + 1}. ${a.question.slice(0, 70)} → ${a.answer}`)
  }

  try {
    await selectResume(page, input.resume)
  } catch (e) {
    const shot = await screenshot(page, 'resume-select-failed', true)
    return {
      status: 'failed',
      errorCode: 'resume_select_failed',
      message: (e as Error).message,
      screenshot: shot,
      answers,
    }
  }

  try {
    await fillForm(page, questions, result.answers)
  } catch (e) {
    const shot = await screenshot(page, 'form-fill-failed', true)
    await dumpHtml(page, 'form-fill-failed')
    return {
      status: 'failed',
      errorCode: 'form_fill_failed',
      message: e instanceof FormFillError ? e.message : `form fill crashed: ${(e as Error).message}`,
      screenshot: shot,
      answers,
    }
  }

  if (input.letter) {
    const wrote = await writeLetter(page, cfg, input.letter, true)
    if (!wrote.ok) {
      const shot = await screenshot(page, 'letter-failed', true)
      return { status: 'failed', errorCode: wrote.errorCode, message: wrote.message, screenshot: shot, answers }
    }
  }

  return finish(page, cfg, input, { answers, quick: true })
}

/** Reveal the cover-letter field and type into it. */
async function writeLetter(
  page: Page,
  cfg: Config,
  letter: string,
  quick = false,
): Promise<{ ok: true } | { ok: false; errorCode: string; message: string }> {
  if (letter.length > cfg.letter.maxChars) {
    return {
      ok: false,
      errorCode: 'letter_too_long_local',
      message: `letter is ${letter.length} chars, cap is ${cfg.letter.maxChars}`,
    }
  }

  // The field does not exist until the toggle is pressed — confirmed by probing.
  const already = await firstMatch(page, selectors.apply.letterTextarea)
  if (!already) {
    const toggleSel = await firstMatch(page, selectors.apply.letterToggle)
    if (!toggleSel) {
      return { ok: false, errorCode: 'no_letter_toggle', message: 'cover-letter toggle not found' }
    }
    await page.locator(toggleSel).first().click()
    if (quick) {
      // Questions flow: wait for the field itself rather than a human-sized pause.
      await page
        .locator(selectors.apply.letterTextarea[0]!)
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => {})
    } else {
      await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
    }
  }

  const areaSel = await firstMatch(page, selectors.apply.letterTextarea)
  if (!areaSel) {
    return { ok: false, errorCode: 'no_letter_field', message: 'cover-letter field never appeared' }
  }

  // Pasted, not typed. fill() dispatches a proper input event, so React registers it,
  // and pasting a prepared letter is what a person actually does anyway. Typing 1500
  // characters would cost ~18s per application and buy nothing.
  const field = page.locator(areaSel).first()
  await field.click()
  await field.fill(letter)

  // Read it back instead of trusting either method. If the form did swallow the
  // value, fall back to key-by-key entry rather than submitting an empty letter —
  // hh rejects those outright (empty_message, §1.3).
  const landed = await field.inputValue().catch(() => '')
  if (landed.trim() !== letter.trim()) {
    log.warn(`fill() left ${landed.length}/${letter.length} chars — retyping`)
    await field.fill('')
    await field.pressSequentially(letter, { delay: 8 })

    const retry = await field.inputValue().catch(() => '')
    if (retry.trim() !== letter.trim()) {
      return {
        ok: false,
        errorCode: 'letter_not_entered',
        message: `field holds ${retry.length} of ${letter.length} chars after two attempts`,
      }
    }
  }
  return { ok: true }
}
