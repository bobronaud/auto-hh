import { chromium, type BrowserContext, type Page } from 'playwright'
import { BROWSER_PROFILE_DIR, SCREENSHOT_DIR, ensureDirs } from '../core/paths.js'
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
  // Visibility, not presence: hh keeps an invisible captcha iframe on ordinary
  // search pages, and checking for its existence halted collection on a page that
  // was showing vacancies perfectly well.
  const captcha =
    (await firstVisibleMatch(page, selectors.antibot.captcha)) ??
    (await firstVisibleMatch(page, selectors.antibot.ddosGuard))
  if (captcha) {
    log.warn(`antibot matched: ${captcha}`)
    return 'captcha'
  }
  const blocked = await firstVisibleMatch(page, selectors.antibot.blocked)
  if (blocked) {
    log.warn(`blocked matched: ${blocked}`)
    return 'blocked'
  }

  // The login URL is decisive on its own — hh redirects there whenever a session dies.
  if (/\/account\/login/.test(page.url())) return 'logged_out'

  if (await firstMatch(page, selectors.auth.loggedIn)) return 'logged_in'
  if (await firstMatch(page, selectors.auth.loginForm)) return 'logged_out'
  if (await firstMatch(page, selectors.auth.loggedOut)) return 'logged_out'
  return 'unknown'
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

/** Navigate, then refuse to continue on anything that needs a human (§2.2, §2.4). */
export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  const state = await detectState(page)

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

export async function screenshot(page: Page, label: string): Promise<string> {
  ensureDirs()
  const safe = label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60)
  const path = resolve(SCREENSHOT_DIR, `${Date.now()}-${safe}.png`)
  await page.screenshot({ path, fullPage: false }).catch(() => {})
  return path
}

/** Randomised pause. Never a bare fixed sleep — that is the most obvious bot tell. */
export function pause(baseMs: number, jitterMs: number): Promise<void> {
  const delta = jitterMs > 0 ? Math.round((Math.random() * 2 - 1) * jitterMs) : 0
  return new Promise((r) => setTimeout(r, Math.max(50, baseMs + delta)))
}

export function randomBetween(minMs: number, maxMs: number): Promise<void> {
  const lo = Math.min(minMs, maxMs)
  const hi = Math.max(minMs, maxMs)
  return new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)))
}
