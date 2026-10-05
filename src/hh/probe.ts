import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import {
  openContext,
  getPage,
  detectState,
  screenshot,
  dumpHtml,
  goto,
  pause,
  waitOutCaptcha,
  HH_BASE,
} from './browser.js'
import { selectors } from './selectors.js'
import { classifyApplyFlow, confirmOtherCountry } from './applyFlow.js'
import { buildSearchUrl } from './searchUrl.js'
import { PROBE_DIR } from '../core/paths.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

const log = logger('probe')

/** How many vacancies to walk before giving up on finding a modal-flow one. */
const MAX_VACANCIES = 8

/**
 * Recon tooling for RESEARCH stage 0.2/0.3.
 *
 * Every selector in selectors.ts is a guess until this has run against a live,
 * logged-in hh.ru. The research is blunt about it: not one reference project ever
 * verified its selectors, because DDoS-Guard kept blocking them. So: walk the real
 * pages, check every candidate, and print what actually exists.
 *
 * Writes a JSON report plus a screenshot per page so a broken selector can be
 * diagnosed later without re-running the whole thing.
 */

interface Hit {
  selector: string
  count: number
  sample?: string
}

interface GroupResult {
  group: string
  key: string
  hits: Hit[]
  status: 'ok' | 'missing'
}

/** First candidate that actually resolves, as a Locator ready to click. */
async function firstLocator(page: Page, candidates: readonly string[]) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first()
      if ((await loc.count()) > 0) return loc
    } catch {
      // A bad candidate must not abort the scan.
    }
  }
  return null
}

async function probeGroup(
  page: Page,
  group: string,
  key: string,
  candidates: readonly string[],
): Promise<GroupResult> {
  const hits: Hit[] = []
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel)
      const count = await loc.count()
      if (count > 0) {
        const sample = (await loc.first().innerText().catch(() => ''))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
        hits.push({ selector: sel, count, sample: sample || undefined })
      }
    } catch (e) {
      log.debug(`invalid selector ${sel}: ${(e as Error).message}`)
    }
  }
  return { group, key, hits, status: hits.length > 0 ? 'ok' : 'missing' }
}

async function probeSection(
  page: Page,
  groupName: string,
  section: Record<string, readonly string[]>,
): Promise<GroupResult[]> {
  const out: GroupResult[] = []
  for (const [key, candidates] of Object.entries(section)) {
    out.push(await probeGroup(page, groupName, key, candidates))
  }
  return out
}

/**
 * Save the real outerHTML of a node. Guessing attributes from a screenshot only
 * goes so far — hh's markup is the ground truth, and a missing selector is almost
 * always a wrong attribute name rather than a missing element.
 */
async function dump(page: Page, name: string, selector: string): Promise<string | null> {
  try {
    const loc = page.locator(selector).first()
    if ((await loc.count()) === 0) return null
    const html = await loc.evaluate((el) => el.outerHTML)
    const path = resolve(PROBE_DIR, `${name}.html`)
    writeFileSync(path, html, 'utf8')
    log.info(`dumped ${name} (${html.length} bytes)`)
    return path
  } catch (e) {
    log.debug(`dump ${name} failed: ${(e as Error).message}`)
    return null
  }
}

export async function probe(cfg: Config): Promise<void> {
  const ctx = await openContext({ ...cfg, browser: { ...cfg.browser, headless: false } })
  const page = await getPage(ctx)
  const results: GroupResult[] = []
  const notes: string[] = []

  try {
    // --- 1. Are we even logged in? Everything downstream depends on it.
    await page.goto(`${HH_BASE}/applicant/negotiations`, { waitUntil: 'domcontentloaded' })
    const state = await detectState(page)
    log.info(`Session state: ${state}`)
    if (state !== 'logged_in') {
      log.error('Not usable. Run `npm run login` first, or solve the captcha in the window.')
      await screenshot(page, 'probe-blocked')
      return
    }
    results.push(...(await probeSection(page, 'auth', selectors.auth)))
    await screenshot(page, 'probe-negotiations')

    // --- 2. Search results page. Post-API-closure this is the only vacancy source.
    const searchUrl = buildSearchUrl(cfg.search, 0)
    log.info(`Search page: ${searchUrl}`)
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    results.push(...(await probeSection(page, 'search', selectors.search)))
    await screenshot(page, 'probe-search')
    await dump(page, 'search-card', selectors.search.card[0]!)
    await dump(page, 'search-pager', '[data-qa*="pager"], nav[aria-label*="страниц"], .pager')

    // Does the card expose has_test at all? Decides whether we can filter tests
    // for free or must open every vacancy page to find out (§3.2).
    const testBadges = await page
      .locator(selectors.search.cardHasTest[0]!)
      .count()
      .catch(() => 0)
    notes.push(
      testBadges > 0
        ? `has_test IS visible in search cards (${testBadges} found) — free filtering.`
        : 'has_test NOT found in search cards — either no test vacancies on this page, or the flag needs the vacancy page. Re-run on a search that surely contains one.',
    )

    // --- 3. Walk several vacancies until a plain (modal) one turns up.
    //
    // Taking only the first result is how the earlier runs kept landing on
    // question-forms: those vacancies are common, and one sample says nothing about
    // the layout of the other flow. Both flows need their markup captured.
    const links = await page
      .locator(selectors.search.cardTitleLink[0]!)
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).href).filter(Boolean).slice(0, 12),
      )
      .catch(() => [] as string[])

    if (links.length === 0) {
      notes.push('Could not read vacancy links from the search results — card selectors are wrong.')
    }

    let modalFound = false
    let questionsDumped = false
    let visited = 0

    for (const vacancyUrl of links) {
      if (modalFound && questionsDumped) break
      if (visited >= MAX_VACANCIES) break
      visited++

      log.info(`[${visited}] ${vacancyUrl}`)
      await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1500)

      if (!results.some((r) => r.group === 'vacancy')) {
        results.push(...(await probeSection(page, 'vacancy', selectors.vacancy)))
        await screenshot(page, 'probe-vacancy')
      }

      const applyBtn = await firstLocator(page, selectors.vacancy.applyButton)
      if (!applyBtn) {
        log.debug('no apply button (already applied? archived?) — next')
        continue
      }

      await applyBtn.click().catch(() => {})
      await page.waitForTimeout(3000)

      const flow = await classifyApplyFlow(page)
      log.info(`   flow: ${flow.kind}${'reason' in flow ? ` (${flow.reason})` : ''}`)

      if (flow.kind === 'needs_human') {
        if (!questionsDumped) {
          // The questions page is worth capturing once: its markup is what the
          // detector keys on, and guessing it wrong means answering forms blindly.
          await screenshot(page, `probe-needs-human-${flow.reason}`)
          await dump(page, `needs-human-${flow.reason}`, 'main, [role="dialog"], form')
          notes.push(`needs_human sample (${flow.reason}): ${vacancyUrl}`)
          questionsDumped = true
        }
        continue
      }

      if (flow.kind !== 'modal') {
        log.debug(`flow ${flow.kind} — next`)
        continue
      }

      // --- 4. The modal. Opened, inspected, NEVER submitted.
      modalFound = true
      notes.push(`modal sample: ${vacancyUrl}`)
      results.push(...(await probeSection(page, 'apply', selectors.apply)))
      await screenshot(page, 'probe-apply-modal')
      await dump(page, 'apply-modal-before', selectors.apply.modal[1]!)

      // The resume dropdown is the one piece routing cannot work without: it decides
      // whether a Vue vacancy actually gets the Vue resume.
      const resumeSel = await firstLocator(page, selectors.apply.resumeSelect)
      if (resumeSel) {
        await resumeSel.click().catch(() => {})
        await page.waitForTimeout(1200)
        await screenshot(page, 'probe-resume-dropdown')
        await dump(page, 'resume-dropdown', selectors.apply.modal[1]!)
        // Options may render in a portal OUTSIDE the modal, so dump the whole body
        // rather than the dialog — a list we cannot see is a list we cannot pick from.
        await dump(page, 'resume-dropdown-body', 'body')
        const titles = await page
          .locator(selectors.apply.resumeTitle[0]!)
          .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))
          .catch(() => [] as string[])
        notes.push(`Resume titles visible after opening the dropdown: ${JSON.stringify(titles)}`)
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(500)
      } else {
        notes.push('Resume dropdown not found — see apply-modal-before.html for its markup.')
      }

      // The letter field does not exist until the toggle is pressed.
      const toggle = await firstLocator(page, selectors.apply.letterToggle)
      if (toggle) {
        log.warn('Clicking "Добавить сопроводительное". Nothing is submitted.')
        await toggle.click().catch(() => {})
        await page.waitForTimeout(1500)
        for (const r of await probeSection(page, 'apply', selectors.apply)) {
          const prev = results.find((x) => x.group === 'apply' && x.key === r.key)
          if (prev && prev.status === 'missing' && r.status === 'ok') Object.assign(prev, r)
        }
        await screenshot(page, 'probe-apply-letter')
        await dump(page, 'apply-modal-after', selectors.apply.modal[1]!)
      } else {
        notes.push('Cover-letter toggle not found — letter field cannot be revealed.')
      }

      const ta = await firstLocator(page, selectors.apply.letterTextarea)
      if (ta) {
        const maxlength = await ta.getAttribute('maxlength').catch(() => null)
        notes.push(
          maxlength
            ? `Letter textarea maxlength = ${maxlength} — set letter.maxChars at or below this.`
            : 'Letter textarea has no maxlength — measure the cap by hand (stage 0.4).',
        )
      }
    }

    if (!modalFound) {
      notes.push(
        `Walked ${visited} vacancies without hitting a plain modal flow. Either the search is ` +
          'dominated by question-forms, or the modal selectors are wrong — check the screenshots.',
      )
    }
  } finally {
    const report = { probedAt: new Date().toISOString(), results, notes }
    const path = resolve(PROBE_DIR, `probe-${Date.now()}.json`)
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8')
    printReport(results, notes, path)
    await ctx.close()
  }
}

function printReport(results: GroupResult[], notes: string[], path: string): void {
  const missing = results.filter((r) => r.status === 'missing')
  const ok = results.filter((r) => r.status === 'ok')

  console.log('\n=== SELECTOR PROBE ===\n')
  for (const r of ok) {
    const best = r.hits[0]!
    console.log(`  ✓ ${r.group}.${r.key}  →  ${best.selector}  (${best.count})`)
    for (const extra of r.hits.slice(1)) console.log(`      also: ${extra.selector} (${extra.count})`)
  }
  if (missing.length) {
    console.log('\n  --- NOT FOUND (fix these in src/hh/selectors.ts) ---')
    for (const r of missing) console.log(`  ✗ ${r.group}.${r.key}`)
  }
  if (notes.length) {
    console.log('\n  --- NOTES ---')
    for (const n of notes) console.log(`  • ${n}`)
  }
  console.log(`\n  Report: ${path}`)
  console.log(`  ${ok.length} found, ${missing.length} missing\n`)
}

/**
 * Capture the employer-questions form of the given vacancies. Opens each one, presses
 * "Откликнуться" and saves the whole response page — HTML plus a full-page screenshot.
 * NOTHING is submitted: the form is read and left as is.
 *
 * The answering code keys on this markup, and a selector written from a screenshot
 * is a guess.
 */
export async function probeForms(cfg: Config, urls: readonly string[]): Promise<void> {
  const ctx = await openContext({ ...cfg, browser: { ...cfg.browser, headless: false } })
  const page = await getPage(ctx)
  try {
    for (const url of urls) {
      log.info(`form probe: ${url}`)
      await goto(page, url, cfg)
      await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)

      const experience = await page
        .locator('[data-qa="vacancy-experience"]')
        .first()
        .innerText()
        .catch(() => null)
      log.info(`   experience: ${experience ?? '—'}`)

      const applyBtn = await firstLocator(page, selectors.vacancy.applyButton)
      if (!applyBtn) {
        log.warn('   no apply button — already applied or archived')
        continue
      }
      await applyBtn.click().catch(() => {})
      await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
      await waitOutCaptcha(page, cfg, 'probe-form')
      if (await confirmOtherCountry(page)) await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)

      const flow = await classifyApplyFlow(page)
      log.info(`   flow: ${flow.kind}${'reason' in flow ? ` (${flow.reason})` : ''} — ${page.url()}`)

      const id = url.match(/vacancy\/(\d+)/)?.[1] ?? 'x'
      const html = await dumpHtml(page, `form-${id}`)
      const shot = resolve(PROBE_DIR, `form-${id}.png`)
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
      log.info(`   saved ${html} · ${shot}`)

      // The letter field on the response page is revealed by its own toggle; capture
      // what appears after pressing it. Still nothing is submitted.
      const toggle = page.locator('[data-qa="vacancy-response-letter-toggle"]').first()
      if ((await toggle.count()) > 0) {
        await toggle.click().catch(() => {})
        await pause(cfg.limits.delayMs, cfg.limits.delayJitterMs)
        const after = await dumpHtml(page, `form-${id}-letter`)
        await page
          .screenshot({ path: resolve(PROBE_DIR, `form-${id}-letter.png`), fullPage: true })
          .catch(() => {})
        log.info(`   letter toggle pressed, saved ${after}`)
      }
    }
  } finally {
    await ctx.close()
  }
}

/**
 * Capture hh's chat: the list, the list with "только непрочитанные" on, and one chat.
 * NOTHING is sent. The chat is a separate app and may live in an iframe, so every
 * frame is dumped, not only the top document.
 *
 * Opening an unread chat marks it read, so unless an id is given the chat opened is
 * one that is NOT in the unread list.
 */
export async function probeChats(cfg: Config, chatId?: string): Promise<void> {
  const ctx = await openContext({ ...cfg, browser: { ...cfg.browser, headless: false } })
  const page = await getPage(ctx)
  try {
    await goto(page, `${HH_BASE}/chat`, cfg)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
    const all = await dumpFrames(page, 'chat-list')
    log.info(`chat list: ${all.links.length} chat links`)

    let unread: string[] = []
    const toggle = await findInFrames(page, (f) => f.getByText(/только непрочитанные/i).first())
    if (toggle) {
      await toggle.click().catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      unread = (await dumpFrames(page, 'chat-list-unread')).links
      log.info(`unread only: ${unread.length} chat links`)
      await toggle.click().catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    } else {
      log.warn('"только непрочитанные" not found in any frame')
    }

    const target = chatId
      ? `${HH_BASE}/chat/${chatId}`
      : all.links.find((l) => !unread.includes(l))
    if (!target) {
      log.warn('no read chat to open — pass an id: selectors:probe -- --chat <id>')
      return
    }
    log.info(`opening ${target}`)
    await goto(page, target, cfg)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
    await dumpFrames(page, 'chat-open')
  } finally {
    await ctx.close()
  }
}

/** Every frame's HTML plus one full screenshot; returns chat links found anywhere. */
async function dumpFrames(page: Page, label: string): Promise<{ links: string[] }> {
  const stamp = Date.now()
  await page.screenshot({ path: resolve(PROBE_DIR, `${label}-${stamp}.png`), fullPage: true }).catch(() => {})
  const links = new Set<string>()
  for (const [i, frame] of page.frames().entries()) {
    try {
      const html = await frame.content()
      const path = resolve(PROBE_DIR, `${label}-${stamp}-frame${i}.html`)
      writeFileSync(path, `<!-- ${frame.url()} -->\n${html}`, 'utf8')
      log.info(`   frame ${i}: ${frame.url()} (${html.length} bytes) → ${path}`)
      const hrefs = await frame
        .locator('a[href*="/chat/"]')
        .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href))
      for (const h of hrefs) if (/\/chat\/\d+/.test(h)) links.add(h)
    } catch (e) {
      log.debug(`frame ${i} dump failed: ${(e as Error).message}`)
    }
  }
  return { links: [...links] }
}

async function findInFrames(
  page: Page,
  pick: (f: import('playwright').Frame) => import('playwright').Locator,
): Promise<import('playwright').Locator | null> {
  for (const frame of page.frames()) {
    const loc = pick(frame)
    if ((await loc.count().catch(() => 0)) > 0) return loc
  }
  return null
}
