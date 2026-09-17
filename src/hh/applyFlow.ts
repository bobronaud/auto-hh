import type { Page } from 'playwright'
import { selectors, firstMatch } from './selectors.js'

/**
 * hh has two apply flows, confirmed by probing live vacancies:
 *
 *   'modal'  — a dialog with a resume dropdown, a cover-letter toggle and submit.
 *              Fully automatable.
 *   'page'   — /applicant/vacancy_response opens as its own page carrying employer
 *              questions or a test. NOT automatable, and should not be: the answers
 *              are free-form text a human has to write, and a generated answer is
 *              worse than no answer.
 *
 * Anything in the second group is parked for manual handling rather than dropped —
 * these are often the most interesting vacancies, precisely because the employer
 * bothered to ask something.
 */
export type ApplyFlow =
  | { kind: 'modal' }
  | { kind: 'needs_human'; reason: NeedsHumanReason; detail?: string }
  | { kind: 'already_applied' }
  | { kind: 'blocked'; reason: 'limit_exceeded' | 'unknown'; detail?: string }

export type NeedsHumanReason =
  | 'employer_questions'
  | 'test_required'
  | 'relocation'
  | 'external_apply'
  | 'resume_hidden'
  | 'unrecognised_form'

export const NEEDS_HUMAN_LABEL: Record<NeedsHumanReason, string> = {
  employer_questions: 'Вопросы работодателя',
  test_required: 'Тестовое задание',
  relocation: 'Требуется подтвердить переезд',
  external_apply: 'Отклик на стороннем сайте',
  resume_hidden: 'Резюме скрыто от работодателей',
  unrecognised_form: 'Незнакомая форма отклика',
}

/**
 * Decide what we are looking at after clicking "Откликнуться".
 *
 * Two rules learned the hard way:
 *
 *   1. Check for the modal FIRST. If a response dialog is open, this is flow A —
 *      whatever else the page says.
 *   2. Scope the question/test checks to the response form, never the whole page.
 *      Vacancy descriptions routinely contain "тестовое задание" as a description of
 *      the hiring process; matching that against the document classified perfectly
 *      ordinary vacancies as unautomatable.
 */
export async function classifyApplyFlow(page: Page): Promise<ApplyFlow> {
  // Hard stops first: these are about the account, not this vacancy.
  if (await firstMatch(page, selectors.apply.limitExceeded)) {
    return { kind: 'blocked', reason: 'limit_exceeded' }
  }

  const modalSel = await firstMatch(page, selectors.apply.modal)

  if (modalSel) {
    const modal = page.locator(modalSel).first()

    if (await hasWithin(modal, selectors.apply.alreadyAppliedNotice)) {
      return { kind: 'already_applied' }
    }
    // A dialog CAN carry questions — some employers ask inside the modal.
    if (await hasWithin(modal, selectors.apply.employerQuestions)) {
      return { kind: 'needs_human', reason: 'employer_questions' }
    }
    // Resume hidden from employers: hh will refuse the application. The warning node
    // is always in the DOM as a collapsed container, so only VISIBILITY counts here.
    if (await visibleWithin(modal, selectors.apply.hiddenResumeWarning)) {
      return { kind: 'needs_human', reason: 'resume_hidden' }
    }
    // A modal with no letter field and no resume picker is not a shape we know.
    const hasLetter = await hasWithin(modal, selectors.apply.letterToggle)
    const hasTextarea = await hasWithin(modal, selectors.apply.letterTextarea)
    const hasResume = await hasWithin(modal, selectors.apply.resumeSelect)
    if (!hasLetter && !hasTextarea && !hasResume) {
      return { kind: 'needs_human', reason: 'unrecognised_form', detail: page.url() }
    }
    return { kind: 'modal' }
  }

  // No modal. Either hh pushed us to the response page, or we left hh entirely.
  const onResponsePage = /\/applicant\/vacancy_response/.test(page.url())

  if (onResponsePage) {
    const form = page.locator('form').first()
    const scope = (await form.count()) > 0 ? form : page.locator('main').first()

    if (await hasWithin(scope, selectors.apply.alreadyAppliedNotice)) {
      return { kind: 'already_applied' }
    }
    if (await hasWithin(scope, selectors.apply.testRedirect)) {
      return { kind: 'needs_human', reason: 'test_required' }
    }
    if (await hasWithin(scope, selectors.apply.employerQuestions)) {
      return { kind: 'needs_human', reason: 'employer_questions' }
    }
    if (await hasWithin(scope, selectors.apply.relocationWarning)) {
      return { kind: 'needs_human', reason: 'relocation' }
    }
    return { kind: 'needs_human', reason: 'unrecognised_form', detail: page.url() }
  }

  let hostname: string
  try {
    hostname = new URL(page.url()).hostname
  } catch {
    return { kind: 'blocked', reason: 'unknown', detail: page.url() }
  }
  if (!/(^|\.)hh\.ru$/.test(hostname)) {
    return { kind: 'needs_human', reason: 'external_apply', detail: page.url() }
  }

  // Still on the vacancy page: the click did nothing we can see.
  return { kind: 'blocked', reason: 'unknown', detail: page.url() }
}

/**
 * Is any candidate actually VISIBLE inside this container?
 *
 * hh keeps collapsed warnings in the DOM with max-height: 0, so presence proves
 * nothing — checking existence would flag every vacancy as blocked.
 */
async function visibleWithin(
  container: ReturnType<Page['locator']>,
  candidates: readonly string[],
): Promise<boolean> {
  for (const sel of candidates) {
    try {
      const loc = container.locator(sel).first()
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        const box = await loc.boundingBox()
        if (box && box.height > 0) return true
      }
    } catch {
      // A bad candidate must not abort the scan.
    }
  }
  return false
}

/** Does any candidate exist INSIDE this container? Scope is the whole point. */
async function hasWithin(
  container: ReturnType<Page['locator']>,
  candidates: readonly string[],
): Promise<boolean> {
  for (const sel of candidates) {
    try {
      if ((await container.locator(sel).count()) > 0) return true
    } catch {
      // A bad candidate must not abort the scan.
    }
  }
  return false
}
