import type { Page } from 'playwright'
import { selectors, firstMatch } from './selectors.js'
import { logger } from '../core/logger.js'
import type { ResumeConfig } from '../config/schema.js'

const log = logger('resume')

/**
 * Choose which resume the application is sent with.
 *
 * Routing decides *which* resume; this puts it into the form. The two must agree or
 * the whole exercise is pointless — sending a Vue vacancy the React resume is worse
 * than not applying, so every path here verifies the selection instead of assuming
 * the click landed.
 *
 * Markup (confirmed by dumping the live modal): the trigger is a div[role="button"]
 * containing [data-qa="resume-title"]; the options render in a portal OUTSIDE the
 * dialog as a radio list of [data-qa="cell"] nodes.
 */

export class ResumeNotFoundError extends Error {
  constructor(
    readonly wanted: string,
    readonly available: string[],
  ) {
    super(
      `Resume "${wanted}" is not in hh's picker. Available: ${available.map((a) => `"${a}"`).join(', ')}. ` +
        'Fix the `title` in config.json to match exactly.',
    )
    this.name = 'ResumeNotFoundError'
  }
}

/** Title currently shown on the trigger, i.e. what hh would send right now. */
export async function currentResumeTitle(page: Page): Promise<string | null> {
  const sel = await firstMatch(page, selectors.apply.resumeSelect)
  if (!sel) return null
  const text = await page
    .locator(sel)
    .first()
    .locator(selectors.apply.resumeTitle[0]!)
    .first()
    .innerText()
    .catch(() => '')
  return normalise(text) || null
}

/**
 * Titles offered by the picker. Only meaningful once the dropdown is open, and the
 * trigger itself also carries a resume-title node — hence the scoping to options.
 */
async function availableTitles(page: Page): Promise<string[]> {
  const options = page.locator(selectors.apply.resumeOption[0]!)
  return (
    await options
      .evaluateAll((els) =>
        els.map((el) => {
          const node = el.querySelector('[data-qa="cell-text-content"]')
          return (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
        }),
      )
      .catch(() => [] as string[])
  ).filter(Boolean)
}

/**
 * Select `resume` in the modal. No-op when it is already selected — opening the
 * dropdown for nothing is an extra interaction hh does not need to see.
 */
export async function selectResume(page: Page, resume: ResumeConfig): Promise<void> {
  const wanted = normalise(resume.title)

  const current = await currentResumeTitle(page)
  if (current && matches(current, wanted)) {
    log.debug(`already on "${resume.id}"`)
    return
  }

  const triggerSel = await firstMatch(page, selectors.apply.resumeSelect)
  if (!triggerSel) {
    // Single-resume accounts get no picker at all. Nothing to choose, but also no
    // way to honour routing — say so rather than applying with whatever is there.
    throw new Error('Resume picker not found in the apply modal — cannot honour routing.')
  }

  await page.locator(triggerSel).first().click()
  await page.waitForTimeout(800)

  const titles = await availableTitles(page)
  if (titles.length === 0) {
    throw new Error('Resume dropdown opened but listed no options — selectors are stale.')
  }

  const target = titles.find((t) => matches(t, wanted))
  if (!target) throw new ResumeNotFoundError(resume.title, titles)

  await page
    .locator(selectors.apply.resumeOption[0]!)
    .filter({ hasText: target })
    .first()
    .click()
  await page.waitForTimeout(800)

  // Verify rather than trust: a click that silently missed would send the wrong
  // resume, and that failure is invisible until an employer reads it.
  const after = await currentResumeTitle(page)
  if (!after || !matches(after, wanted)) {
    throw new Error(
      `Selected "${resume.title}" but the form still shows "${after ?? 'nothing'}". Aborting.`,
    )
  }
  log.info(`resume → ${resume.id} ("${after}")`)
}

function normalise(s: string): string {
  // hh renders non-breaking spaces inside titles; a plain === would never match.
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
}

function matches(a: string, b: string): boolean {
  return normalise(a).toLocaleLowerCase('ru') === normalise(b).toLocaleLowerCase('ru')
}
