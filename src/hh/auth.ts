import type { BrowserContext, Page } from 'playwright'
import { HH_BASE, openContext, getPage, detectState, screenshot, type PageState } from './browser.js'
import { logger } from '../core/logger.js'
import { limitWarnings, type Config } from '../config/schema.js'

const log = logger('auth')

/**
 * One-time manual login (RESEARCH §2.1).
 *
 * We never type the password, never read the SMS code, never touch the captcha.
 * The browser opens headful, the human logs in, and the persistent profile keeps
 * the session for every later run. Storing hh credentials in a config file would
 * buy nothing — hh challenges new devices anyway — and lose a lot.
 */
export async function login(cfg: Config): Promise<void> {
  if (cfg.browser.headless) {
    throw new Error('Cannot log in headless — a human has to type the code and pass the captcha.')
  }

  for (const w of limitWarnings(cfg)) log.warn(w)

  const ctx = await openContext({ ...cfg, browser: { ...cfg.browser, headless: false } })
  const page = await getPage(ctx)

  try {
    await page.goto(`${HH_BASE}/account/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    // Only a positive 'logged_in' short-circuits. 'unknown' means we could not tell,
    // and the safe reading of "could not tell" is "keep the window open".
    const initial = await detectState(page)
    if (initial === 'logged_in') {
      log.info('Already logged in — the existing profile is still valid. Nothing to do.')
      return
    }
    if (initial === 'unknown') {
      log.warn('Could not recognise this page. Leaving the window open — log in if you see a form.')
    }

    log.info('Browser is open. Log in by hand: password, SMS/email code, captcha if asked.')
    log.info(`Waiting up to ${Math.round(cfg.browser.manualActionTimeoutMs / 1000)}s. The window stays open until you are in.`)

    await waitForLogin(page, cfg.browser.manualActionTimeoutMs)
    log.info('Logged in. Session saved to the persistent profile — later runs reuse it.')
  } finally {
    await ctx.close()
  }
}

/**
 * Poll rather than wait on a selector: logging in takes several navigations, and a
 * captcha step in the middle would break any single waitFor.
 */
async function waitForLogin(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastState: PageState | null = null

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Browser window was closed before login finished.')

    const state = await detectState(page).catch(() => 'unknown' as const)
    if (state !== lastState) {
      log.debug(`page state: ${state}`)
      lastState = state
    }
    if (state === 'logged_in') return

    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s. If you did log in, the loggedIn selectors are stale — ` +
      'run `npm run selectors:probe` while logged in.',
  )
}

export interface HealthReport {
  loggedIn: boolean
  state: string
  url: string
  screenshot?: string
}

/**
 * Pre-flight check (§2.3). Deliberately does NOT try to re-login on its own —
 * an automated login attempt is exactly what escalates a soft block into a hard one.
 */
export async function health(cfg: Config): Promise<HealthReport> {
  const ctx: BrowserContext = await openContext(cfg)
  const page = await getPage(ctx)
  try {
    await page.goto(`${HH_BASE}/applicant/negotiations`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    const state = await detectState(page)
    const report: HealthReport = { loggedIn: state === 'logged_in', state, url: page.url() }
    if (state !== 'logged_in') report.screenshot = await screenshot(page, `health-${state}`)
    return report
  } finally {
    await ctx.close()
  }
}
