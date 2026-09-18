import type { Page } from 'playwright'
import { selectors, firstMatch, firstVisibleMatch } from './selectors.js'
import { classifyApplyFlow, confirmOtherCountry, type NeedsHumanReason } from './applyFlow.js'
import { selectResume } from './resumePicker.js'
import { goto, screenshot, pause, randomBetween } from './browser.js'
import { logger } from '../core/logger.js'
import type { Config, ResumeConfig } from '../config/schema.js'

const log = logger('apply')

export type ApplyOutcome =
  | { status: 'applied'; resumeId: string; screenshot?: string }
  | { status: 'dry_run'; resumeId: string; screenshot?: string }
  | { status: 'needs_human'; reason: NeedsHumanReason; screenshot?: string }
  | { status: 'skipped'; reason: 'already_applied' | 'archived' | 'no_apply_button' }
  | { status: 'failed'; errorCode: string; message: string; screenshot?: string }
  | { status: 'blocked'; errorCode: 'limit_exceeded'; screenshot?: string }

export interface ApplyInput {
  url: string
  resume: ResumeConfig
  letter?: string | null
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
  await goto(page, input.url)
  await randomBetween(cfg.limits.readPauseMsMin, cfg.limits.readPauseMsMax)

  if (await firstVisibleMatch(page, selectors.vacancy.archived)) {
    return { status: 'skipped', reason: 'archived' }
  }
  if (await firstVisibleMatch(page, selectors.vacancy.alreadyApplied)) {
    return { status: 'skipped', reason: 'already_applied' }
  }

  const applySel = await firstMatch(page, selectors.vacancy.applyButton)
  if (!applySel) return { status: 'skipped', reason: 'no_apply_button' }

  await page.locator(applySel).first().click()
  await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)

  // Предупреждение о вакансии в другой стране стоит ПЕРЕД формой отклика и формой
  // не является. Подтверждаем и ждём то, что откроется следом.
  if (await confirmOtherCountry(page)) {
    await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
  }

  const flow = await classifyApplyFlow(page)

  if (flow.kind === 'already_applied') return { status: 'skipped', reason: 'already_applied' }

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

  if (cfg.dryRun) {
    const shot = await screenshot(page, `dry-run-${input.resume.id}`)
    log.info(`DRY RUN — everything ready, submit NOT clicked (${input.resume.id})`)
    return { status: 'dry_run', resumeId: input.resume.id, screenshot: shot }
  }

  const submitSel = await firstMatch(page, selectors.apply.submitButton)
  if (!submitSel) {
    const shot = await screenshot(page, 'no-submit-button')
    return {
      status: 'failed',
      errorCode: 'no_submit_button',
      message: 'apply modal had no submit button',
      screenshot: shot,
    }
  }

  await page.locator(submitSel).first().click()
  await pause(cfg.limits.delayMs + 1500, cfg.limits.delayJitterMs)

  // Confirm rather than assume. Without positive evidence the application is NOT
  // recorded as sent — a false 'applied' would both skip a real vacancy forever and
  // consume a slot in the rolling window that hh never actually counted.
  const ok = await firstVisibleMatch(page, selectors.apply.success)
  const shot = await screenshot(page, `applied-${input.resume.id}`)

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
      }
    }
    return {
      status: 'failed',
      errorCode: 'no_success_confirmation',
      message: 'submitted but hh showed no confirmation — check the screenshot',
      screenshot: shot,
    }
  }

  return { status: 'applied', resumeId: input.resume.id, screenshot: shot }
}

/** Reveal the cover-letter field and type into it. */
async function writeLetter(
  page: Page,
  cfg: Config,
  letter: string,
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
    await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
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
