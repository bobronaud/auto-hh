import type { Locator, Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SCREENSHOT_DIR, ensureDirs } from '../core/paths.js'
import { logger } from '../core/logger.js'
import { createProvider, isConfigured, type LlmProvider } from '../llm/provider.js'
import { selectors } from './selectors.js'
import { findCaptcha, pause } from './browser.js'
import type { Config } from '../config/schema.js'

const log = logger('captcha')

/** Ceiling for the picture to appear and load: the dialog animates in. */
const PICTURE_TIMEOUT_MS = 15_000
/** Ceiling for hh to accept or reject a typed answer. */
const OUTCOME_TIMEOUT_MS = 15_000

const DONT_KNOW = 'НЕ ЗНАЮ'

export const CAPTCHA_SYSTEM =
  'Ты читаешь текст с картинки капчи. Отвечай только символами с картинки, без пояснений.'

export function captchaPrompt(): string {
  return [
    'На картинке искажённый текст капчи: обычно два слова, часто русские.',
    'Перепиши его ровно как на картинке, слова через один пробел, в нижнем регистре.',
    'Ответ — одна строка, только сам текст, без кавычек и пояснений.',
    `Если прочитать невозможно — ответь ${DONT_KNOW}.`,
  ].join('\n')
}

/**
 * The model's reply → the text to type, or null when there is nothing worth typing.
 *
 * The last non-empty line wins and a "Ответ:"-style prefix is dropped, so a stray
 * preamble does not get glued into the answer. Letters, digits and single spaces
 * survive: hh's captcha is two words ("промокшему нефе", live screenshot 22.09), and
 * the space between them is part of the answer. \p{L} with /u, because \w would strip
 * every Cyrillic letter (pitfall §1).
 */
export function parseCaptchaAnswer(raw: string): string | null {
  if (/не\s*знаю/iu.test(raw)) return null
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1)
  if (!last) return null
  const text = last
    .replace(/^[\p{L}\s]*:\s*/u, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text.length < 2 || text.length > 40) return null
  return text
}

export interface SolveOptions {
  provider?: LlmProvider
  /** Where picture screenshots go; tests point it away from data/. */
  shotDir?: string
}

/**
 * Read the captcha picture through the LLM, log what was read and type it in.
 *
 * Returns true once the captcha is gone. false hands it to the human: the attempts
 * ran out, the picture never loaded, or the LLM could not be called at all (logged
 * out, subscription paused, CLI missing). The captcha is left open in every false
 * case — waitOutCaptcha then waits for a person exactly as before.
 */
export async function solveCaptcha(page: Page, cfg: Config, opts: SolveOptions = {}): Promise<boolean> {
  if (!isConfigured(cfg)) {
    log.warn('LLM не настроен (llm.provider = none) — капчу вводит человек')
    return false
  }
  const provider = opts.provider ?? createProvider(cfg)
  const attempts = cfg.browser.captchaAutoAttempts

  for (let i = 1; i <= attempts; i++) {
    const picture = await loadedPicture(page)
    if (!picture) {
      log.warn('картинка капчи не найдена или не загрузилась — капчу вводит человек')
      return false
    }
    const src = await picture.getAttribute('src').catch(() => null)

    const shot = await pictureShot(picture, opts.shotDir)
    if (!shot) {
      log.warn('не удалось снять картинку капчи — капчу вводит человек')
      return false
    }

    let raw: string
    try {
      const res = await provider.complete({
        system: CAPTCHA_SYSTEM,
        prompt: captchaPrompt(),
        images: [{ mediaType: 'image/png', base64: readFileSync(shot).toString('base64') }],
      })
      raw = res.text
    } catch (e) {
      // Not a bad reading but a broken channel: further attempts would fail the same way.
      log.error(`claude -p недоступен: ${(e as Error).message} — капчу вводит человек`)
      return false
    }

    const text = parseCaptchaAnswer(raw)
    if (!text) {
      log.warn(`капча: не распознана (попытка ${i}/${attempts}), модель ответила «${raw.slice(0, 80)}»`, {
        shot,
      })
      if (i < attempts) await renewPicture(page, src)
      continue
    }

    log.warn(`капча: распознано «${text}» (попытка ${i}/${attempts})`, { shot })

    const outcome = await typeAnswer(page, text, src)
    if (outcome === 'gone') {
      log.info(`капча: «${text}» принят`)
      return true
    }
    if (outcome === 'no_form') {
      log.warn('поле или кнопка капчи не найдены — капчу вводит человек')
      return false
    }
    log.warn(`капча: «${text}» не принят (${outcome === 'wrong' ? 'неверный текст' : 'нет ответа hh'})`)
  }

  log.warn(`капча не пройдена за ${attempts} попытки — капчу вводит человек`)
  return false
}

/** The first visible picture candidate, once the image has actually decoded. */
async function loadedPicture(page: Page): Promise<Locator | null> {
  const deadline = Date.now() + PICTURE_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const sel of selectors.antibot.captchaPicture) {
      const loc = page.locator(sel).first()
      try {
        if (!(await loc.isVisible())) continue
        // Inline callback: tsx keepNames breaks named functions inside evaluate (pitfall §3).
        const ready = await loc.evaluate((img) => {
          const el = img as HTMLImageElement
          return el.complete && el.naturalWidth > 0
        })
        if (ready) return loc
      } catch {
        // Re-rendering mid-check; try again.
      }
    }
    await pause(250, 80)
  }
  return null
}

async function pictureShot(picture: Locator, dir?: string): Promise<string | null> {
  ensureDirs()
  const path = resolve(dir ?? SCREENSHOT_DIR, `${Date.now()}-captcha-picture.png`)
  try {
    await picture.screenshot({ path })
    return path
  } catch {
    return null
  }
}

/** «Другой текст», then wait for the picture to actually change. */
async function renewPicture(page: Page, oldSrc: string | null): Promise<void> {
  for (const sel of selectors.antibot.captchaRenew) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {})
      break
    }
  }
  await pictureChanged(page, oldSrc, 5_000)
}

async function pictureChanged(page: Page, oldSrc: string | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const sel of selectors.antibot.captchaPicture) {
      const src = await page.locator(sel).first().getAttribute('src', { timeout: 500 }).catch(() => null)
      if (src && src !== oldSrc) return true
    }
    await pause(250, 80)
  }
  return false
}

type Outcome = 'gone' | 'wrong' | 'timeout' | 'no_form'

async function typeAnswer(page: Page, text: string, oldSrc: string | null): Promise<Outcome> {
  const input = await firstVisible(page, selectors.antibot.captchaInput)
  const submit = await firstVisible(page, selectors.antibot.captchaSubmit)
  if (!input || !submit) return 'no_form'

  try {
    // Typed key by key, ~0.5s apart (owner, 05.10): fill() pasted the whole value in
    // one input event, and hh rejected correctly read text as "Неверный текст".
    await input.click()
    await input.fill('')
    for (const ch of text) {
      await page.keyboard.type(ch)
      await pause(500, 60)
    }
    await submit.click()
  } catch {
    return 'no_form'
  }

  // DOM state only, with a ceiling: gone means accepted; an error line or a fresh
  // picture means hh rejected the text and is offering another go.
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS
  while (Date.now() < deadline) {
    await pause(300, 100)
    const still = await findCaptcha(page).catch(() => 'unknown')
    if (!still) return 'gone'
    if (await errorShown(page)) return 'wrong'
    if (await pictureChanged(page, oldSrc, 1)) return 'wrong'
  }
  return 'timeout'
}

/**
 * The error line sits in the DOM from the start, collapsed under an aria-hidden
 * wrapper — the same trap as hidden-resume-warning (pitfall §2.1). Shown means
 * visible AND no aria-hidden ancestor.
 */
async function errorShown(page: Page): Promise<boolean> {
  for (const sel of selectors.antibot.captchaError) {
    const loc = page.locator(sel).first()
    try {
      if (!(await loc.isVisible())) continue
      if (await loc.evaluate((el) => el.closest('[aria-hidden="true"]') === null)) return true
    } catch {
      // Re-rendering mid-check.
    }
  }
  return false
}

async function firstVisible(page: Page, candidates: readonly string[]): Promise<Locator | null> {
  for (const sel of candidates) {
    const loc = page.locator(sel).first()
    if (await loc.isVisible().catch(() => false)) return loc
  }
  return null
}
