import type { Page } from 'playwright'
import { selectors, firstMatch, firstVisibleMatch } from './selectors.js'
import { logger } from '../core/logger.js'

const log = logger('apply')

/**
 * hh has two apply flows, confirmed by probing live vacancies:
 *
 *   'modal'      — a dialog with a resume dropdown, a cover-letter toggle and submit.
 *   'questions'  — /applicant/vacancy_response opens as its own page carrying the
 *                  employer's questions. Answered automatically since 05.10 (owner's
 *                  call, reversing the earlier "a human has to write these"): the
 *                  model answers, responseForm.ts fills it in.
 *
 * A separate hh test is still parked for manual handling, and so is a form the model
 * could not answer (form_unanswered).
 */
export type ApplyFlow =
  | { kind: 'modal' }
  | { kind: 'questions' }
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
  | 'form_unanswered'

export const NEEDS_HUMAN_LABEL: Record<NeedsHumanReason, string> = {
  employer_questions: 'Вопросы работодателя',
  test_required: 'Тестовое задание',
  relocation: 'Требуется подтвердить переезд',
  external_apply: 'Отклик на стороннем сайте',
  resume_hidden: 'Резюме скрыто от работодателей',
  unrecognised_form: 'Незнакомая форма отклика',
  form_unanswered: 'Не смог ответить на вопрос формы',
}

/**
 * Пройти предупреждение «Вы откликаетесь на вакансию в другой стране».
 *
 * hh вклинивает его между кнопкой «Откликнуться» и формой отклика: диалог с двумя
 * кнопками, «Все равно откликнуться» и «Отменить». Подтверждаем всегда — цель
 * максимум откликов, а отказ работодателя по географии стоит дешевле, чем
 * неотправленный отклик. После подтверждения идёт обычный поток: либо модалка,
 * либо страница /applicant/vacancy_response.
 *
 * Возвращает true, если кнопку нажали, — вызывающий даёт странице время на
 * следующий шаг. Проверяем ВИДИМОСТЬ, не существование, и логируем сработавший
 * селектор: детектор без имени селектора неотлаживаем.
 */
export async function confirmOtherCountry(page: Page): Promise<boolean> {
  const sel = await firstVisibleMatch(page, selectors.apply.confirmOtherCountry)
  if (!sel) return false
  log.info(`   другая страна — подтверждаем отклик (${sel})`)
  await page.locator(sel).first().click()
  return true
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
    // A dialog CAN carry questions — some employers ask inside the modal. Answered
    // like the page when it carries the same task-body markup; otherwise it is a
    // shape we have never seen, and that goes to the human.
    if (await hasWithin(modal, selectors.apply.employerQuestions)) {
      return (await hasWithin(modal, selectors.responseForm.question))
        ? { kind: 'questions' }
        : { kind: 'needs_human', reason: 'employer_questions' }
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
    // NOT page.locator('form').first(): the first form in the DOM is hh's header
    // search (action="/search/vacancy"). Scoping the checks to it found nothing, and
    // every page of employer questions fell through to 'unrecognised_form' — the
    // bucket meant for shapes we do not know. The response form lives inside main.
    //
    // main is a safe fallback here, unlike on a vacancy page: the response page
    // carries no vacancy description, which is the text that made narrow scoping a
    // rule in the first place.
    const responseForm = page.locator('main form').first()
    const main = page.locator('main').first()
    const scope =
      (await responseForm.count()) > 0
        ? responseForm
        : (await main.count()) > 0
          ? main
          : page.locator('body')

    if (await hasWithin(scope, selectors.apply.alreadyAppliedNotice)) {
      return { kind: 'already_applied' }
    }
    if (await hasWithin(scope, selectors.apply.testRedirect)) {
      return { kind: 'needs_human', reason: 'test_required' }
    }
    // Before relocation on purpose: "Готовы ли вы к переезду?" is a common question
    // in these forms, and the relocation warning matches its text.
    if (await hasWithin(scope, selectors.apply.employerQuestions)) {
      return (await hasWithin(scope, selectors.responseForm.question))
        ? { kind: 'questions' }
        : { kind: 'needs_human', reason: 'employer_questions' }
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
