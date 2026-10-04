import { chromium, type BrowserContext, type Page } from 'playwright'
import { writeFileSync } from 'node:fs'
import { BROWSER_PROFILE_DIR, PROBE_DIR, SCREENSHOT_DIR, ensureDirs } from '../core/paths.js'
import { logger } from '../core/logger.js'
import { selectors, firstMatch, firstVisibleMatch } from './selectors.js'
import type { Config } from '../config/schema.js'
import { resolve } from 'node:path'

const log = logger('browser')

export const HH_BASE = 'https://hh.ru'

/**
 * Minimal anti-detection (RESEARCH §2.2).
 *
 * Deliberately small. This is not a bypass and does not pretend to be one: it only
 * removes the two loudest automation tells. Anything heavier (full stealth suites,
 * captcha solvers) is explicitly rejected by the research — solving captchas
 * automatically is the fastest way to turn a temporary block into a permanent one.
 */
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = window.chrome || { runtime: {} };
  Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru'] });
`

/**
 * Safety net for a tsx/esbuild quirk.
 *
 * tsx compiles with keepNames, which rewrites `const f = () => {}` into
 * `const f = __name(() => {}, "f")`. When such a callback is serialised into the page
 * for evaluate(), `__name` is not defined there and the call throws mid-run.
 *
 * The real fix is to keep evaluate() callbacks free of named function bindings — and
 * that is the rule (CLAUDE.md). This identity shim only stops a future slip from
 * killing a run that is already halfway through applying.
 */
const ESBUILD_NAME_SHIM = `
  globalThis.__name = globalThis.__name || function (fn) { return fn };
`

export async function openContext(cfg: Config): Promise<BrowserContext> {
  ensureDirs()

  // launchPersistentContext, not storageState: the profile carries localStorage,
  // IndexedDB and fingerprint, so hh sees the same device every run (§2.1).
  const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: cfg.browser.headless,
    locale: cfg.browser.locale,
    timezoneId: cfg.browser.timezone,
    slowMo: cfg.browser.slowMoMs || undefined,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })

  await ctx.addInitScript(STEALTH_INIT)
  await ctx.addInitScript(ESBUILD_NAME_SHIM)

  if (cfg.browser.headless) {
    log.warn('headless=true — DDoS-Guard is harsher here and there is no way to solve a captcha. Prefer headful.')
  }
  return ctx
}

export async function getPage(ctx: BrowserContext): Promise<Page> {
  const existing = ctx.pages()[0]
  return existing ?? (await ctx.newPage())
}

/**
 * 'unknown' is a first-class answer, not a synonym for 'ok'.
 *
 * Absence of evidence is not evidence: hh serves plenty of pages carrying neither
 * logged-in chrome nor a login link. Collapsing that into 'ok' is what made `login`
 * report "already logged in" while staring at the login form.
 */
export type PageState = 'logged_in' | 'logged_out' | 'captcha' | 'blocked' | 'unknown'

/**
 * What are we actually looking at? Every navigation goes through this before the
 * caller trusts the DOM. Antibot is checked first: a captcha page can still carry
 * logged-in chrome and would otherwise read as logged in.
 */
export async function detectState(page: Page): Promise<PageState> {
  const captcha = await findCaptcha(page)
  if (captcha) {
    log.warn(`antibot matched: ${captcha}`)
    return 'captcha'
  }

  // Text signals are checked ONLY on a page that carries no hh interface. A real
  // DDoS-Guard interstitial is a bare page; on live search results the string
  // "DDoS-Guard" shows up as an employer's name, and matching it across the document
  // stopped collection on a page full of vacancies.
  if (!(await looksLikeHhPage(page))) {
    const challenge = await firstVisibleMatch(page, selectors.antibot.ddosGuard)
    if (challenge) {
      log.warn(`antibot interstitial: ${challenge}`)
      return 'captcha'
    }
    const blocked = await firstVisibleMatch(page, selectors.antibot.blocked)
    if (blocked) {
      log.warn(`blocked: ${blocked}`)
      return 'blocked'
    }
  }

  // The login URL is decisive on its own — hh redirects there whenever a session dies.
  if (/\/account\/login/.test(page.url())) return 'logged_out'

  if (await firstMatch(page, selectors.auth.loggedIn)) return 'logged_in'
  if (await firstMatch(page, selectors.auth.loginForm)) return 'logged_out'
  if (await firstMatch(page, selectors.auth.loggedOut)) return 'logged_out'
  return 'unknown'
}

/**
 * Is a captcha on screen right now? Returns the selector that matched — a detector
 * that stops the run without naming its selector is undebuggable (RESEARCH §7.4).
 *
 * Visibility, not presence: hh keeps an invisible captcha iframe on ordinary search
 * pages, and checking for its existence halted collection on a page that was showing
 * vacancies perfectly well.
 *
 * Two tiers on purpose. Attribute candidates are checked across the document; the
 * text ones only inside an overlay container, because the page underneath a captcha
 * modal is a vacancy page and its description is exactly the text that made loose
 * text matching a rule against itself.
 */
export async function findCaptcha(page: Page): Promise<string | null> {
  const byAttribute = await anyVisible(page, selectors.antibot.captcha)
  if (byAttribute) return byAttribute

  for (const scopeSel of selectors.antibot.captchaScope) {
    const scope = page.locator(scopeSel).first()
    try {
      if ((await scope.count()) === 0 || !(await scope.isVisible())) continue
    } catch {
      continue
    }
    for (const textSel of selectors.antibot.captchaText) {
      try {
        const loc = scope.locator(textSel).first()
        if ((await loc.count()) > 0 && (await loc.isVisible())) return `${scopeSel} >> ${textSel}`
      } catch {
        // A bad candidate must not abort the scan.
      }
    }
  }
  return null
}

/**
 * Which candidate has a VISIBLE element — any of them, not just the first in the DOM.
 *
 * firstVisibleMatch stops at .first(), and that is wrong here specifically: hh keeps
 * an invisible captcha iframe on ordinary pages, so the real, visible captcha can sit
 * second and read as absent. Scanning a handful of matches per candidate is enough;
 * a captcha is never the fiftieth node of its kind.
 */
async function anyVisible(page: Page, candidates: readonly string[]): Promise<string | null> {
  for (const sel of candidates) {
    try {
      const all = page.locator(sel)
      const n = Math.min(await all.count(), 5)
      for (let i = 0; i < n; i++) {
        const loc = all.nth(i)
        if (!(await loc.isVisible())) continue
        const box = await loc.boundingBox()
        if (box && box.width > 0 && box.height > 0) return sel
      }
    } catch {
      // A bad candidate must not abort the scan.
    }
  }
  return null
}

/**
 * A captcha is up: hand the keyboard to the human, then carry on.
 *
 * hh can raise one mid-flow, after the submit click, with no navigation — so the
 * checks in goto() never see it. Walking the rest of the queue through a captcha wall
 * is both pointless and the exact traffic that turns a temporary challenge into a
 * block: on 22.09 it cost 63 vacancies in a row.
 *
 * We do NOT read the picture (invariant 2). The browser is headful and already open
 * on the captcha — the owner types the letters, we watch the DOM until it is gone and
 * resume the same application. What separates a temporary challenge from a permanent
 * ban is who pressed the keys, so that is the one part not automated.
 *
 * Headless has nobody to ask, and a run that timed out waiting is over: both throw
 * HumanNeededError, which unwinds to the apply loop. It breaks WITHOUT writing an
 * `applications` row, so the vacancy keeps its place in the queue (invariant 11).
 *
 * Returns true if a captcha was solved — the caller has to re-check whatever it was
 * waiting for, since the click that raised the captcha did not go through.
 */
export async function waitOutCaptcha(page: Page, cfg: Config, label: string): Promise<boolean> {
  const sel = await findCaptcha(page)
  if (!sel) return false

  const shot = await screenshot(page, `captcha-${label}`)
  const dump = await dumpHtml(page, `captcha-${label}`)
  log.error(`captcha matched: ${sel}`, { url: page.url(), shot, dump })

  if (cfg.browser.headless) {
    log.error('headless — nobody can type the captcha. Stopping.')
    throw new HumanNeededError('captcha', shot)
  }

  const timeoutMs = cfg.browser.manualActionTimeoutMs
  log.warn(
    `КАПЧА. Введите её в открытом окне браузера — прогон продолжится сам. ` +
      `Жду до ${Math.round(timeoutMs / 1000)}с.`,
  )

  const deadline = Date.now() + timeoutMs
  let lastNudge = Date.now()

  while (Date.now() < deadline) {
    // Polling our own DOM, not hh: this loop generates no traffic, so the interval is
    // about how fast we notice, not about looking human.
    await pause(2000, 400)

    let still: string | null
    try {
      still = await findCaptcha(page)
    } catch {
      // The human may be mid-navigation; a failed probe is not an answer.
      continue
    }

    if (!still) {
      log.info('капча пройдена — продолжаем')
      // Let hh finish whatever the solved captcha released.
      await pause(1500, 300)
      return true
    }

    if (Date.now() - lastNudge > 30_000) {
      lastNudge = Date.now()
      log.warn(`жду капчу, осталось ${Math.round((deadline - Date.now()) / 1000)}с`)
    }
  }

  log.error(`капча не пройдена за ${Math.round(timeoutMs / 1000)}с — останавливаюсь`)
  throw new HumanNeededError('captcha', shot)
}

/**
 * Save the page HTML next to the screenshot. A PNG shows that something unexpected
 * happened; only the markup says which selector would have caught it.
 */
export async function dumpHtml(page: Page, label: string): Promise<string | null> {
  ensureDirs()
  const safe = label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60)
  const path = resolve(PROBE_DIR, `${safe}-${Date.now()}.html`)
  try {
    writeFileSync(path, await page.content(), 'utf8')
    return path
  } catch {
    return null
  }
}

/** Is this an hh page at all, or an antibot interstitial wearing its URL? */
export async function looksLikeHhPage(page: Page): Promise<boolean> {
  return (await firstMatch(page, selectors.hhChrome)) !== null
}

export class HumanNeededError extends Error {
  constructor(
    readonly state: PageState,
    readonly screenshot?: string,
  ) {
    super(
      state === 'captcha'
        ? 'Captcha or DDoS-Guard challenge — solve it in the open browser window, then rerun.'
        : state === 'logged_out'
          ? 'Session is logged out — run `npm run login`.'
          : state === 'blocked'
            ? 'hh.ru is blocking this session. Stop, wait, and do not retry in a loop.'
            : 'Unrecognised page — selectors are probably stale. Check the screenshot.',
    )
    this.name = 'HumanNeededError'
  }
}

/**
 * Navigate, then refuse to continue on anything that needs a human (§2.2, §2.4).
 *
 * With cfg the captcha case is not fatal: the owner types it in the open window and
 * the same navigation is re-checked. Without cfg (no caller today) the old behaviour
 * stands — stop and call a human.
 */
export async function goto(page: Page, url: string, cfg?: Config): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  let state = await detectState(page)

  if (state === 'captcha' && cfg) {
    await waitOutCaptcha(page, cfg, 'navigation')
    // hh usually returns to the requested page by itself; ask for it again if it did
    // not, then judge the page we actually ended up on.
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    }
    state = await detectState(page)
  }

  if (state === 'logged_in') return

  // 'unknown' is not fatal here: a vacancy page may legitimately lack auth chrome.
  // Callers that need certainty (auth.ts) check detectState themselves.
  if (state === 'unknown') {
    log.debug('Page state unrecognised — continuing, but selectors may be stale.', { url })
    return
  }

  const shot = await screenshot(page, `state-${state}`)
  log.error(`Page state: ${state}`, { url, shot })
  throw new HumanNeededError(state, shot)
}

export async function screenshot(page: Page, label: string, fullPage = false): Promise<string> {
  ensureDirs()
  const safe = label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60)
  const path = resolve(SCREENSHOT_DIR, `${Date.now()}-${safe}.png`)
  // fullPage for question forms: the answers run well below the fold, and a
  // screenshot of the first two is no evidence of what was sent.
  await page.screenshot({ path, fullPage }).catch(() => {})
  return path
}

/** Randomised pause. Never a bare fixed sleep — that is the most obvious bot tell. */
export function pause(baseMs: number, jitterMs: number): Promise<void> {
  const delta = jitterMs > 0 ? Math.round((Math.random() * 2 - 1) * jitterMs) : 0
  return new Promise((r) => setTimeout(r, Math.max(50, baseMs + delta)))
}

/** The gap between vacancies and between search pages (limits.gapMs). 0 means none — not a 50ms floor. */
export function gap(cfg: Config): Promise<void> {
  const { gapMs, delayJitterMs } = cfg.limits
  return gapMs > 0 ? pause(gapMs, delayJitterMs) : Promise.resolve()
}

export function randomBetween(minMs: number, maxMs: number): Promise<void> {
  const lo = Math.min(minMs, maxMs)
  const hi = Math.max(minMs, maxMs)
  return new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)))
}
