/**
 * What the vacancy explicitly asks the cover letter to contain.
 *
 * Employers who ask for something and do not get it read that as not reading the
 * posting — so these two requests are answered directly, even the one we answer in
 * the negative.
 */

export interface LetterRequirements {
  /** The posting asks for salary expectations. */
  wantsSalary: boolean
  /** The posting asks for GitHub, a portfolio, or links to work. */
  wantsLinks: boolean
}

/**
 * ⚠️ \w and \b are ASCII-only in JavaScript — they do not match Cyrillic. Word
 * fragments here use \p{L} with the /u flag; a bare `ссылк\w*` silently never matches
 * "ссылки", which is exactly how these two patterns failed the first time.
 */
const SALARY =
  /зарплатн\p{L}*\s+ожидани|ожидани\p{L}*\s+по\s+(?:зарплат|доход|уровн)|укажите[^.\n]{0,40}(?:зарплат|вилк|доход)|желаем\p{L}*\s+(?:зарплат|доход|уровень)|уровень\s+дохода|salary\s+expectation/iu

const LINKS =
  /github|гитхаб|портфолио|portfolio|ссылк\p{L}*\s+на\s+(?:\p{L}+\s+){0,2}(?:проект|работ|код|репозитор)|примеры\s+(?:работ|кода|проектов)|pet[-\s]?проект|пет[-\s]?проект|gitlab/iu

export function detectRequirements(
  title: string,
  description?: string | null,
): LetterRequirements {
  const text = `${title}\n${description ?? ''}`
  return {
    wantsSalary: SALARY.test(text),
    wantsLinks: LINKS.test(text),
  }
}
