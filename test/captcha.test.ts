import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { parseCaptchaAnswer, solveCaptcha } from '../src/hh/captcha.js'
import { findCaptcha } from '../src/hh/browser.js'
import { configSchema, type Config } from '../src/config/schema.js'
import type { CompletionRequest, LlmProvider } from '../src/llm/provider.js'

test('parseCaptchaAnswer: plain latin and cyrillic', () => {
  assert.equal(parseCaptchaAnswer('xK7pq'), 'xK7pq')
  assert.equal(parseCaptchaAnswer('рыбак'), 'рыбак')
})

test('parseCaptchaAnswer: two words keep one space between them', () => {
  assert.equal(parseCaptchaAnswer('промокшему нефе'), 'промокшему нефе')
  assert.equal(parseCaptchaAnswer('  промокшему\t  нефе. '), 'промокшему нефе')
})

test('parseCaptchaAnswer: quotes, spaces, prefix, preamble', () => {
  assert.equal(parseCaptchaAnswer('«ab 12»'), 'ab 12')
  assert.equal(parseCaptchaAnswer('Ответ: щука7'), 'щука7')
  assert.equal(parseCaptchaAnswer('На картинке текст\nmoroz'), 'moroz')
})

test('parseCaptchaAnswer: dont-know and junk → null', () => {
  assert.equal(parseCaptchaAnswer('НЕ ЗНАЮ'), null)
  assert.equal(parseCaptchaAnswer('не знаю, слишком размыто'), null)
  assert.equal(parseCaptchaAnswer(''), null)
  assert.equal(parseCaptchaAnswer('x'), null)
})

const fixture = readFileSync(new URL('./fixtures/captcha.html', import.meta.url), 'utf8')
const shotDir = mkdtempSync(join(tmpdir(), 'captcha-test-'))

function cfg(attempts = 3): Config {
  const base = configSchema.parse(
    JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')),
  )
  return {
    ...base,
    llm: { ...base.llm, provider: 'claude-cli' },
    browser: { ...base.browser, captchaAutoAttempts: attempts },
  }
}

function fakeProvider(answers: (string | Error)[]): LlmProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = []
  return {
    name: 'fake',
    model: 'fake',
    calls,
    async complete(req) {
      calls.push(req)
      const a = answers[Math.min(calls.length - 1, answers.length - 1)]!
      if (a instanceof Error) throw a
      return { text: a, model: 'fake' }
    },
  }
}

let browser: Browser
let page: Page
before(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
})
after(async () => browser.close())

test('captcha dialog is detected', async () => {
  await page.setContent(fixture)
  assert.ok(await findCaptcha(page))
})

test('right answer: typed, submitted, captcha gone', async () => {
  await page.setContent(fixture)
  const provider = fakeProvider(['AB12'])
  assert.equal(await solveCaptcha(page, cfg(), { provider, shotDir }), true)
  assert.equal(provider.calls.length, 1)
  assert.equal(provider.calls[0]!.images?.[0]?.mediaType, 'image/png')
  assert.ok(provider.calls[0]!.images![0]!.base64.length > 100)
  assert.equal(await findCaptcha(page), null)
})

test('wrong answers: stops after the configured attempts, captcha left open', async () => {
  await page.setContent(fixture)
  const provider = fakeProvider(['ZZZZ'])
  assert.equal(await solveCaptcha(page, cfg(3), { provider, shotDir }), false)
  assert.equal(provider.calls.length, 3)
  assert.equal(await page.evaluate(() => (window as unknown as { submits: number }).submits), 3)
  assert.ok(await findCaptcha(page))
})

test('second attempt succeeds after a wrong one', async () => {
  await page.setContent(fixture)
  const provider = fakeProvider(['ZZZZ', 'AB12'])
  assert.equal(await solveCaptcha(page, cfg(3), { provider, shotDir }), true)
  assert.equal(provider.calls.length, 2)
})

test('claude -p unavailable: one call, nothing typed, captcha left open', async () => {
  await page.setContent(fixture)
  const provider = fakeProvider([new Error('claude CLI failed: not logged in')])
  assert.equal(await solveCaptcha(page, cfg(3), { provider, shotDir }), false)
  assert.equal(provider.calls.length, 1)
  assert.equal(await page.evaluate(() => (window as unknown as { submits: number }).submits), 0)
  assert.ok(await findCaptcha(page))
})

test('llm.provider = none: nobody is called', async () => {
  await page.setContent(fixture)
  const provider = fakeProvider(['AB12'])
  const c = { ...cfg(), llm: { ...cfg().llm, provider: 'none' as const } }
  assert.equal(await solveCaptcha(page, c, { provider, shotDir }), false)
  assert.equal(provider.calls.length, 0)
})
