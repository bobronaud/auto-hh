import type { Locator, Page } from 'playwright'
import { selectors, firstMatch } from './selectors.js'
import { OPEN_OPTION_VALUE, type FormAnswer, type FormQuestion } from '../answers/types.js'
import { logger } from '../core/logger.js'

const log = logger('apply')

export type ReadForm =
  | { ok: true; questions: FormQuestion[] }
  | { ok: false; reason: string }

/**
 * Read the employer's questions off the response page (or a modal carrying them).
 *
 * Markup confirmed on live dumps — see selectors.responseForm. Anything outside the
 * three known shapes (a select, a file upload, a question without text) fails the
 * whole form up front: answering what we can see and sending the rest blank is worse
 * than parking the vacancy.
 *
 * The evaluate callback is all inline expressions — tsx's keepNames turns a
 * `const f = () => …` into a __name() call the browser has never heard of.
 */
export async function readForm(page: Page): Promise<ReadForm> {
  const qSel = await firstMatch(page, selectors.responseForm.question)
  if (!qSel) return { ok: false, reason: 'вопросы формы не найдены на странице' }

  const raw = await page.locator(qSel).evaluateAll(
    (els, s) =>
      els.map((el) => {
        const textNode = el.querySelector(s.text)
        const radios = Array.from(el.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
        const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
        const choices = radios.length > 0 ? radios : boxes
        const areas = Array.from(el.querySelectorAll('textarea')) as HTMLTextAreaElement[]
        const others = el.querySelectorAll(
          'select, input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])',
        ).length
        return {
          text: (textNode?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          kind: radios.length > 0 ? 'radio' : boxes.length > 0 ? 'checkbox' : areas.length > 0 ? 'text' : 'unknown',
          field: choices.length > 0 ? choices[0]!.name : (areas[0]?.name ?? ''),
          options: choices.map((c) => ({
            value: c.value,
            label: (
              c.closest('label')?.querySelector(s.option)?.textContent ??
              c.closest('label')?.textContent ??
              ''
            )
              .replace(/\s+/g, ' ')
              .trim(),
          })),
          openField: choices.some((c) => c.value === 'open') ? `${choices[0]!.name}_text` : null,
          others,
        }
      }),
    { text: selectors.responseForm.questionText[0]!, option: selectors.responseForm.optionText[0]! },
  )

  const questions: FormQuestion[] = []
  for (const [i, q] of raw.entries()) {
    const n = i + 1
    if (!q.text) return { ok: false, reason: `вопрос ${n}: нет текста вопроса` }
    if (q.kind === 'unknown' || q.others > 0) {
      return { ok: false, reason: `вопрос ${n} «${q.text.slice(0, 80)}»: незнакомый тип поля` }
    }
    if (!q.field) return { ok: false, reason: `вопрос ${n} «${q.text.slice(0, 80)}»: у поля нет name` }
    questions.push({
      index: n,
      text: q.text,
      kind: q.kind as FormQuestion['kind'],
      field: q.field,
      options: q.options,
      openField: q.openField,
    })
  }
  if (questions.length === 0) return { ok: false, reason: 'форма без вопросов' }
  return { ok: true, questions }
}

export class FormFillError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormFillError'
  }
}

/**
 * Put every answer into the form and read each one back. No pauses between fields
 * (owner, 05.10): the only waiting is for a concrete DOM state — the "Свой вариант"
 * field appearing after its option is picked.
 */
export async function fillForm(
  page: Page,
  questions: readonly FormQuestion[],
  answers: ReadonlyMap<number, FormAnswer>,
): Promise<void> {
  for (const q of questions) {
    const a = answers.get(q.index)
    if (!a) throw new FormFillError(`вопрос ${q.index}: нет ответа`)

    if (a.kind === 'text') {
      if (q.kind !== 'text') throw new FormFillError(`вопрос ${q.index}: текст на вопрос с вариантами`)
      await fillText(page.locator(`textarea[name="${css(q.field)}"]`).first(), a.text, q.index)
      continue
    }

    for (const value of a.values) {
      const input = page.locator(`input[name="${css(q.field)}"][value="${css(value)}"]`).first()
      if ((await input.count()) === 0) throw new FormFillError(`вопрос ${q.index}: нет варианта ${value}`)
      if (!(await input.isChecked())) {
        // The input itself is visually hidden behind hh's styled radio; the label is
        // what a person clicks.
        await page.locator(`label:has(input[name="${css(q.field)}"][value="${css(value)}"])`).first().click()
      }
      if (!(await input.isChecked())) {
        throw new FormFillError(`вопрос ${q.index}: вариант ${value} не отметился`)
      }
    }

    if (a.text && a.values.includes(OPEN_OPTION_VALUE)) {
      if (!q.openField) throw new FormFillError(`вопрос ${q.index}: нет поля для своего варианта`)
      const area = page.locator(`textarea[name="${css(q.openField)}"]`).first()
      await area.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
      await fillText(area, a.text, q.index)
    }
  }
  log.info(`   форма заполнена: ${questions.length} вопросов`)
}

async function fillText(field: Locator, text: string, index: number): Promise<void> {
  if ((await field.count()) === 0) throw new FormFillError(`вопрос ${index}: поле ответа не найдено`)
  await field.fill(text)
  if ((await field.inputValue().catch(() => '')).trim() === text.trim()) return

  // Same fallback as the letter: fill() swallowed by the form → type it.
  await field.fill('')
  await field.pressSequentially(text, { delay: 5 })
  const landed = await field.inputValue().catch(() => '')
  if (landed.trim() !== text.trim()) {
    throw new FormFillError(`вопрос ${index}: в поле ${landed.length} из ${text.length} символов`)
  }
}

/** Escape a value for a double-quoted CSS attribute selector. */
function css(v: string): string {
  return v.replace(/["\\]/g, '\\$&')
}
