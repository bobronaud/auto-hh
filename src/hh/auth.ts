import type { BrowserContext, Page } from 'playwright'
import { HH_BASE, openContext, getPage, detectState, screenshot } from './browser.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

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

  const ctx = await openContext({ ...cfg, browser: { ...cfg.browser, headless: false } })
  const page = await getPage(ctx)

  try {
    await page.goto(`${HH_BASE}/account/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    if ((await detectState(page)) === 'ok') {
      log.info('Already logged in — the existing profile is still valid. Nothing to do.')
      return
    }

    log.info('Browser is open. Log in by hand: password, SMS/email code, captcha if asked.')
    log.info(`Waiting up to ${Math.round(cfg.browser.manualActionTimeoutMs / 1000)}s...`)

    await waitForLogin(page, cfg.browser.manualActionTimeoutMs)
    log.info('Logged in. Session saved to the persistent profile — later runs reuse it.')
  } finally {
    await ctx.close()
  }
}

/** Poll rather than wait on a selector: the user may take several navigations to get there. */
async function waitForLogin(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Browser window was closed before login finished.')
    if ((await detectState(page).catch(() => 'logged_out' as const)) === 'ok') return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Timed out waiting for manual login.')
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
    const report: HealthReport = { loggedIn: state === 'ok', state, url: page.url() }
    if (state !== 'ok') report.screenshot = await screenshot(page, `health-${state}`)
    return report
  } finally {
    await ctx.close()
  }
}
