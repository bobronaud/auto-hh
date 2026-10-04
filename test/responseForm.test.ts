import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { readForm, fillForm } from '../src/hh/responseForm.js'
import type { FormAnswer } from '../src/answers/types.js'

// Fixtures are the form part of live response pages (data/probe/form-*.html, 05.10),
// trimmed of classes, images and hidden inputs.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')

let browser: Browser
let page: Page
before(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
})
after(async () => browser.close())

test('text questions', async () => {
  await page.setContent(fixture('form-text'))
  const r = await readForm(page)
  assert.ok(r.ok)
  assert.equal(r.questions.length, 5)
  assert.equal(r.questions[0]!.kind, 'text')
  assert.match(r.questions[0]!.text, /уровню дохода/)
  assert.match(r.questions[0]!.field, /^task_\d+_text$/)
})

test('mixed text and radio', async () => {
  await page.setContent(fixture('form-text-radio'))
  const r = await readForm(page)
  assert.ok(r.ok)
  assert.deepEqual(r.questions.map((q) => q.kind), ['text', 'radio', 'text'])
  assert.deepEqual(r.questions[1]!.options.map((o) => o.label), ['Да', 'Нет'])
  assert.equal(r.questions[1]!.openField, null)
})

test('radio with "Свой вариант"', async () => {
  await page.setContent(fixture('form-radio-open'))
  const r = await readForm(page)
  assert.ok(r.ok)
  const q = r.questions[0]!
  assert.equal(q.kind, 'radio')
  assert.equal(q.options.at(-1)!.label, 'Свой вариант')
  assert.equal(q.options.at(-1)!.value, 'open')
  assert.equal(q.openField, `${q.field}_text`)
})

test('the resume radio list is not mistaken for a question', async () => {
  await page.setContent(fixture('form-text-radio'))
  const r = await readForm(page)
  assert.ok(r.ok)
  assert.ok(r.questions.every((q) => !q.options.some((o) => /разработчик/.test(o.label))))
})

test('fillForm puts answers in and reads them back', async () => {
  await page.setContent(fixture('form-text-radio'))
  const r = await readForm(page)
  assert.ok(r.ok)
  const [t1, rad, t2] = r.questions as [typeof r.questions[0], typeof r.questions[0], typeof r.questions[0]]
  const answers = new Map<number, FormAnswer>([
    [t1.index, { kind: 'text', text: '150 000 руб' }],
    [rad.index, { kind: 'choice', values: [rad.options[0]!.value], text: null }],
    [t2.index, { kind: 'text', text: 'Да, соответствует. Живу в Москве.' }],
  ])
  await fillForm(page, r.questions, answers)
  assert.equal(await page.locator(`textarea[name="${t1.field}"]`).inputValue(), '150 000 руб')
  assert.ok(await page.locator(`input[name="${rad.field}"][value="${rad.options[0]!.value}"]`).isChecked())
})

test('unknown field type fails the form', async () => {
  await page.setContent('<main><form><div data-qa="task-body"><div data-qa="task-question">Город?</div><select name="task_1"></select></div></form></main>')
  const r = await readForm(page)
  assert.equal(r.ok, false)
})
