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
  | 'unrecognised_form'

export const NEEDS_HUMAN_LABEL: Record<NeedsHumanReason, string> = {
  employer_questions: 'Вопросы работодателя',
  test_required: 'Тестовое задание',
  relocation: 'Требуется подтвердить переезд',
  external_apply: 'Отклик на стороннем сайте',
  unrecognised_form: 'Незнакомая форма отклика',
}

/**
 * Decide what we are looking at after clicking "Откликнуться".
 *
 * Order matters. `already_applied` and `limit_exceeded` are checked before the
 * needs-human reasons: a vacancy we already answered is not a task for the human,
 * and an exhausted limit stops the whole run rather than parking one vacancy.
 */
export async function classifyApplyFlow(page: Page): Promise<ApplyFlow> {
  if (await firstMatch(page, selectors.apply.limitExceeded)) {
    return { kind: 'blocked', reason: 'limit_exceeded' }
  }
  if (await firstMatch(page, selectors.apply.alreadyAppliedNotice)) {
    return { kind: 'already_applied' }
  }

  if (await firstMatch(page, selectors.apply.testRedirect)) {
    return { kind: 'needs_human', reason: 'test_required' }
  }
  if (await firstMatch(page, selectors.apply.employerQuestions)) {
    return { kind: 'needs_human', reason: 'employer_questions' }
  }

  const onModal = await firstMatch(page, selectors.apply.modal)
  if (onModal) return { kind: 'modal' }

  // No modal and we were pushed to the response page: flow B, whatever the exact
  // shape. Better to park it than to guess at a form we have never seen.
  if (/\/applicant\/vacancy_response/.test(page.url())) {
    return { kind: 'needs_human', reason: 'unrecognised_form', detail: page.url() }
  }

  // Left hh entirely — some employers route to their own ATS.
  if (!/(^|\.)hh\.ru$/.test(new URL(page.url()).hostname)) {
    return { kind: 'needs_human', reason: 'external_apply', detail: page.url() }
  }

  return { kind: 'blocked', reason: 'unknown', detail: page.url() }
}
