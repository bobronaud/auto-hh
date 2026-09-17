import type { Page } from 'playwright'
import { selectors, firstMatch, firstVisibleMatch } from './selectors.js'
import { goto } from './browser.js'

/**
 * Read a vacancy page.
 *
 * Needed because the search card carries no description, and without one the letter
 * has nothing to aim at: no stack to echo back, and no way to notice the posting
 * asking for salary expectations or portfolio links.
 */

export interface VacancyDetails {
  description: string | null
  hasTest: boolean | null
  archived: boolean
}

export async function fetchVacancyDetails(page: Page, url: string): Promise<VacancyDetails> {
  await goto(page, url)

  if (await firstVisibleMatch(page, selectors.vacancy.archived)) {
    return { description: null, hasTest: null, archived: true }
  }

  const descSel = await firstMatch(page, selectors.vacancy.description)
  const description = descSel
    ? ((await page.locator(descSel).first().innerText().catch(() => '')) || null)
    : null

  // A badge proves a test exists; its absence proves nothing, so stay null rather
  // than write false over a flag a later pass might fill in.
  const testBadge = await firstMatch(page, selectors.vacancy.hasTestBadge)

  return {
    description: description ? normalise(description) : null,
    hasTest: testBadge ? true : null,
    archived: false,
  }
}

/** Collapse hh's heavy whitespace without losing paragraph structure. */
function normalise(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
