import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { collectAlarms, SuspectStreak, SUSPECT_STREAK_LIMIT } from '../src/pipeline/tripwires.js'
import { judgeSearch, judgeThread, judgeForm, judgeChatList } from '../src/pipeline/selfcheck.js'
import { readThread } from '../src/hh/chat.js'
import { readForm } from '../src/hh/responseForm.js'
import type { ApplyOutcome } from '../src/hh/apply.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')

let browser: Browser
let page: Page
before(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
})
after(async () => browser.close())

// ------------------------------------------------------------- tripwires

test('collect: no cards on the first page raises an alarm naming the card selector', () => {
  const [a] = collectAlarms({ pages: 1, domCards: 0, parsedCards: 0, withCompany: 0 })
  assert.match(a!, /selectors\.search\.card/)
})

test('collect: cards in the DOM that do not parse point at the title selector', () => {
  assert.match(collectAlarms({ pages: 1, domCards: 50, parsedCards: 0, withCompany: 0 })[0]!, /cardTitleLink/)
  assert.match(collectAlarms({ pages: 2, domCards: 100, parsedCards: 60, withCompany: 60 })[0]!, /cardTitleLink/)
})

test('collect: no employer on any card points at the company selector', () => {
  assert.match(collectAlarms({ pages: 1, domCards: 50, parsedCards: 50, withCompany: 0 })[0]!, /cardCompany/)
})

test('collect: an ordinary walk raises nothing', () => {
  assert.deepEqual(collectAlarms({ pages: 3, domCards: 150, parsedCards: 148, withCompany: 140 }), [])
})

const noButton: ApplyOutcome = { status: 'skipped', reason: 'no_apply_button' }
const applied: ApplyOutcome = { status: 'applied', resumeId: 'react' }
const unknown: ApplyOutcome = { status: 'failed', errorCode: 'unknown_state', message: 'x' }

test('apply: three suspect outcomes in a row trip the wire', () => {
  const s = new SuspectStreak()
  for (let i = 1; i < SUSPECT_STREAK_LIMIT; i++) assert.equal(s.push(noButton), null)
  const alarm = s.push(unknown)
  assert.ok(alarm)
  assert.match(alarm, /applyButton/)
  assert.match(alarm, /apply\.modal/)
})

test('apply: an ordinary outcome resets the streak', () => {
  const s = new SuspectStreak()
  s.push(noButton)
  s.push(noButton)
  assert.equal(s.push(applied), null)
  assert.equal(s.push(noButton), null)
  // Archived and parked-for-questions are the vacancy, not the markup.
  assert.equal(s.push({ status: 'skipped', reason: 'archived' }), null)
  assert.equal(s.push({ status: 'needs_human', reason: 'test_required' }), null)
})

// ------------------------------------------------------------- verdicts

test('search verdict', () => {
  const card = { hhId: '1', title: 'Frontend', company: 'ООО' }
  assert.equal(judgeSearch([card, card], 2), null)
  assert.ok(judgeSearch([], 0))
  assert.ok(judgeSearch([], 20))
  assert.ok(judgeSearch([card], 20))
  assert.ok(judgeSearch(Array(10).fill({ ...card, company: null }), 10))
})

test('chat list verdict', () => {
  assert.ok(judgeChatList([]))
  assert.equal(judgeChatList([{ id: '1', title: 'Frontend', company: 'ООО' }]), null)
  assert.ok(judgeChatList([{ id: '1', title: null, company: null }, { id: '2', title: null, company: null }]))
})

test('thread verdict: the 29.10 markup reads as working', async () => {
  await page.setContent(fixture('chat-open-2910'))
  assert.equal(judgeThread(await readThread(page), { bot: true }), null)
})

test('thread verdict: the 27-29.10 breakage — bubbles not found — is caught', async () => {
  // What the parser saw for days: the bubble wrapper under a name it did not know.
  const html = fixture('chat-open-2910').replace(/chatik-chat-message-bubble /g, 'something-else ')
  await page.setContent(html)
  const v = await readThread(page)
  assert.ok(v.messages.length > 0, 'system lines still parse — that is why it looked fine')
  assert.match(judgeThread(v, { bot: true })!, /ни одного сообщения/)
})

test('thread verdict: a bot chat whose bot is not recognised is caught', async () => {
  await page.setContent(fixture('chat-open-2910').replace(/data-qa="chat-bubble-label"/g, 'data-qa="x"'))
  const v = await readThread(page)
  assert.match(judgeThread(v, { bot: true })!, /бот/)
  // In a chat not known to hold a bot, the same thread is not a verdict on the markup.
  assert.equal(judgeThread(v, { bot: false }), null)
})

test('form verdict on the live-dump fixtures', async () => {
  for (const name of ['form-text', 'form-text-radio', 'form-radio-open']) {
    await page.setContent(fixture(name))
    assert.equal(judgeForm(await readForm(page)), null, name)
  }
  await page.setContent('<main><form></form></main>')
  assert.ok(judgeForm(await readForm(page)))
})
