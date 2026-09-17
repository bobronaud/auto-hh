/**
 * Word-boundary matching for stack keywords.
 *
 * `includes` is wrong here and quietly so: "ui" fires inside "build" and "guide",
 * "ts" inside "products", "vue" inside "value". Each such hit is an application sent
 * to a vacancy that has nothing to do with frontend.
 *
 * JS's \b is ASCII-only, so it cannot be used against Russian titles either — the
 * boundaries are spelled out as Unicode property escapes instead.
 */

const cache = new Map<string, RegExp>()

function wordRegex(needle: string): RegExp {
  let re = cache.get(needle)
  if (re) return re
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Letters and digits on either side block a match; punctuation and spaces do not,
  // so "React," "Vue.js" and "(React)" all count while "products" does not.
  re = new RegExp(`(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`, 'giu')
  cache.set(needle, re)
  return re
}

/** How many times `needle` appears as a standalone word in `haystack`. */
export function countWordHits(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0
  const re = wordRegex(needle)
  re.lastIndex = 0
  return (haystack.match(re) ?? []).length
}

/** Does any of `needles` appear as a standalone word? */
export function hasAnyWord(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => countWordHits(haystack, n) > 0)
}

/** How many of `needles` appear at least once. Counts distinct keywords, not hits. */
export function countMatchingWords(haystack: string, needles: readonly string[]): number {
  return needles.reduce((n, needle) => n + (countWordHits(haystack, needle) > 0 ? 1 : 0), 0)
}
