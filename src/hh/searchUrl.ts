import type { SearchConfig } from '../config/schema.js'
import { HH_BASE } from './browser.js'

/**
 * Build an hh.ru search URL from config.
 *
 * Parameter names follow hh's own search page, which mirrors the OpenAPI spec
 * (RESEARCH §1.3). Two traps worth naming:
 *   - professional_role is SINGULAR (the obvious plural guess is wrong)
 *   - schedule is deprecated; work_format is the current knob
 *
 * We hit the HTML search page, not the API: the hh API is closed (§1.4).
 */
export function buildSearchUrl(search: SearchConfig, page = 0): string {
  const p = new URLSearchParams()

  p.set('text', search.text)
  for (const f of search.searchField) p.append('search_field', f)
  // No area param at all when none are configured — passing an empty value would
  // make hh fall back to the profile's own region instead of searching everywhere.
  for (const a of search.area) p.append('area', a)
  for (const w of search.workFormat) p.append('work_format', w)

  if (search.experience) p.set('experience', search.experience)
  if (search.excludedText.length) p.set('excluded_text', search.excludedText.join(', '))

  p.set('search_period', String(search.period))
  p.set('order_by', 'publication_time')
  p.set('items_on_page', '50')
  if (page > 0) p.set('page', String(page))

  return `${HH_BASE}/search/vacancy?${p.toString()}`
}
