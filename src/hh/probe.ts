import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { openContext, getPage, detectState, screenshot, HH_BASE } from './browser.js'
import { selectors } from './selectors.js'
import { buildSearchUrl } from './searchUrl.js'
import { PROBE_DIR } from '../core/paths.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

const log = logger('probe')

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
    if (state !== 'ok') {
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

    // --- 3. A real vacancy page, reached the way the scraper will reach it.
    const firstCard = page.locator(selectors.search.cardTitleLink[0]!).first()
    const href = await firstCard.getAttribute('href').catch(() => null)
    if (href) {
      const vacancyUrl = href.startsWith('http') ? href : `${HH_BASE}${href}`
      log.info(`Vacancy page: ${vacancyUrl}`)
      await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)
      results.push(...(await probeSection(page, 'vacancy', selectors.vacancy)))
      await screenshot(page, 'probe-vacancy')
      notes.push(`Probed vacancy: ${vacancyUrl}`)

      // --- 4. The apply modal. Opened but NEVER submitted — probe is read-only.
      const applySel = selectors.vacancy.applyButton.find(Boolean)
      const applyBtn = page.locator(applySel!).first()
      if ((await applyBtn.count()) > 0) {
        log.warn('Opening the apply modal. Nothing will be submitted — probe never clicks send.')
        await applyBtn.click().catch(() => {})
        await page.waitForTimeout(3000)
        results.push(...(await probeSection(page, 'apply', selectors.apply)))
        await screenshot(page, 'probe-apply-modal')

        // Stage 0.4: the letter length cap is undocumented — read it off the DOM.
        const ta = page.locator(selectors.apply.letterTextarea[0]!).first()
        if ((await ta.count()) > 0) {
          const maxlength = await ta.getAttribute('maxlength').catch(() => null)
          notes.push(
            maxlength
              ? `Letter textarea maxlength = ${maxlength} — set letter.maxChars below this.`
              : 'Letter textarea has no maxlength attribute — measure the cap by hand (stage 0.4).',
          )
        } else {
          notes.push('Letter textarea not found — it may appear only after a "cover letter" toggle.')
        }
      } else {
        notes.push('Apply button not found on this vacancy (already applied? archived? external apply?).')
      }
    } else {
      notes.push('Could not read a vacancy link from the search results — card selectors are wrong.')
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
