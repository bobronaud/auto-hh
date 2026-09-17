/**
 * ⚠️  ЕДИНСТВЕННАЯ ТОЧКА ПОЧИНКИ. RESEARCH §7.4.
 *
 * Вся вёрстка hh.ru живёт здесь и больше нигде. Когда hh выкатит редизайн —
 * ломается этот файл, а не пайплайн. Не инлайнить селекторы в browser/search/apply.
 *
 * СТАТУС: НЕ ПРОВЕРЕНО НА ЖИВОМ hh. Значения ниже — гипотезы, снятые с публично
 * описанных data-qa атрибутов hh. Этап 0.2/0.3 ресёрча: запустить `npm run
 * selectors:probe` на залогиненной сессии и заменить всё, что не подтвердилось.
 *
 * Правило: каждый селектор — МАССИВ кандидатов, пробуем по порядку. hh нередко
 * держит старую и новую вёрстку одновременно (A/B, раскатка по регионам).
 */

export type SelectorCandidates = readonly string[]

export const selectors = {
  /** Признаки того, что мы залогинены (§2.3). */
  auth: {
    loggedIn: [
      '[data-qa="mainmenu_applicantProfile"]',
      '[data-qa="mainmenu_myResumes"]',
      'a[href*="/applicant/resumes"]',
    ],
    loggedOut: [
      '[data-qa="login"]',
      'a[href*="/account/login"]',
      '[data-qa="mainmenu_login"]',
    ],
    /**
     * Positive evidence that we are ON the login page. Needed because the absence
     * of logged-in chrome is not itself proof of anything — hh renders plenty of
     * pages with neither marker.
     */
    loginForm: [
      '[data-qa="account-signup-submit"]',
      '[data-qa="account-login-submit"]',
      'input[name="username"]',
      'input[name="login"]',
      'input[type="password"]',
      'form[action*="/account/login"]',
      '[data-qa="expand-login-by-password"]',
    ],
  },

  /** Антибот. Ловим, останавливаемся, зовём человека (§2.2). Никогда не решаем сами. */
  antibot: {
    captcha: [
      '[data-qa="account-captcha-picture"]',
      'iframe[src*="captcha"]',
      'iframe[src*="smartcaptcha"]',
      '#ddg-captcha',
      'form[action*="captcha"]',
    ],
    ddosGuard: [
      'text=/DDoS-?Guard/i',
      'text=/проверка вашего браузера/i',
    ],
    blocked: [
      'text=/Доступ ограничен/i',
      'text=/слишком много запросов/i',
    ],
  },

  /** Карточки поисковой выдачи. После закрытия API это ЕДИНСТВЕННЫЙ источник вакансий. */
  search: {
    resultsRoot: ['[data-qa="vacancy-serp__results"]', 'main'],
    card: ['[data-qa="vacancy-serp__vacancy"]', '[data-qa="serp-item"]'],
    cardTitleLink: ['[data-qa="serp-item__title"]', 'a[data-qa="vacancy-serp__vacancy-title"]'],
    cardCompany: ['[data-qa="vacancy-serp__vacancy-employer"]'],
    cardSalary: [
      '[data-qa="vacancy-serp__vacancy-compensation"]',
      '[data-qa="vacancy-serp__vacancy_compensation"]',
    ],
    cardArea: ['[data-qa="vacancy-serp__vacancy-address"]'],
    cardSnippet: [
      '[data-qa="vacancy-serp__vacancy_snippet_responsibility"]',
      '[data-qa="vacancy-serp__vacancy_snippet_requirement"]',
    ],
    /** Метка тестового задания прямо в карточке — если её нет, has_test остаётся NULL. */
    cardHasTest: ['[data-qa="vacancy-serp__vacancy-with-test"]'],
    /** Кнопка отклика прямо из выдачи (быстрый путь, минует страницу вакансии). */
    cardApplyButton: ['[data-qa="vacancy-serp__vacancy_response"]'],
    nextPage: ['[data-qa="pager-next"]', 'a[data-qa="pager-next"]'],
  },

  /** Страница вакансии. */
  vacancy: {
    title: ['[data-qa="vacancy-title"]'],
    company: ['[data-qa="vacancy-company-name"]'],
    salary: ['[data-qa="vacancy-salary"]', '[data-qa="vacancy-salary-compensation-type-net"]'],
    description: ['[data-qa="vacancy-description"]'],
    archived: ['[data-qa="vacancy-archive-informer"]', 'text=/Вакансия в архиве/i'],
    applyButton: [
      '[data-qa="vacancy-response-link-top"]',
      '[data-qa="vacancy-response-link-bottom"]',
      'a[href*="/applicant/vacancy_response"]',
    ],
    alreadyApplied: [
      '[data-qa="vacancy-response-link-view-topic"]',
      'text=/Вы откликнулись/i',
    ],
    hasTestBadge: ['[data-qa="vacancy-response-link-top-with-test"]', 'text=/с тестовым заданием/i'],
  },

  /**
   * Модалка отклика. Подтверждённая probe механика:
   *   открыть модалку → выбрать резюме в кастомном дропдауне (не <select>)
   *   → нажать «Добавить сопроводительное» → поле письма ПОЯВЛЯЕТСЯ в DOM
   *   → ввести текст → «Откликнуться»
   * Поле письма отсутствует до нажатия тоггла — искать его раньше бессмысленно.
   */
  apply: {
    modal: ['[data-qa="vacancy-response-popup"]', 'div[role="dialog"]'],
    /** Кастомный дропдаун, не select. Клик раскрывает список резюме. */
    resumeSelect: [
      '[data-qa="resume-select"]',
      '[data-qa="vacancy-response-popup-resume-select"]',
      'div[role="dialog"] [role="combobox"]',
      'div[role="dialog"] button:has(img)',
    ],
    resumeOption: [
      '[data-qa="resume-select-option"]',
      '[role="option"]',
      'div[role="dialog"] [role="listbox"] li',
    ],
    /** Раскрывает поле письма. Текст — самый надёжный якорь до уточнения data-qa. */
    letterToggle: [
      '[data-qa="vacancy-response-letter-toggle"]',
      'button:has-text("Добавить сопроводительное")',
      'text=Добавить сопроводительное',
    ],
    letterTextarea: [
      '[data-qa="vacancy-response-popup-form-letter-input"]',
      'textarea[data-qa*="letter"]',
      'textarea[name="letter"]',
      'div[role="dialog"] textarea',
    ],
    submitButton: [
      '[data-qa="vacancy-response-submit-popup"]',
      '[data-qa="vacancy-response-letter-submit"]',
      'button[type="submit"]',
    ],
    /** Подтверждение успеха. Без него отклик НЕ считается отправленным. */
    success: [
      '[data-qa="vacancy-response-success"]',
      'text=/Отклик отправлен/i',
      'text=/Резюме отправлено/i',
    ],
    /** Экраны, требующие человека: тест, вопросы работодателя, релокация. */
    testRedirect: ['text=/тестовое задание/i', '[data-qa="vacancy-test"]'],
    employerQuestions: ['[data-qa="vacancy-response-questions"]'],
    relocationWarning: ['text=/переезд/i'],
    /** Лимит исчерпан (§1.3, limit_exceeded). */
    limitExceeded: ['text=/лимит откликов/i', 'text=/превышено количество откликов/i'],
    tooLongMessage: ['text=/слишком длинн/i'],
  },
} as const

/**
 * Первый кандидат, который реально нашёлся на странице. Возвращает null, а не
 * бросает — вызывающий код решает, фатально это или нет.
 */
export async function firstMatch(
  page: { locator: (s: string) => { first: () => { count: () => Promise<number> } } },
  candidates: SelectorCandidates,
): Promise<string | null> {
  for (const s of candidates) {
    try {
      if ((await page.locator(s).first().count()) > 0) return s
    } catch {
      // Невалидный селектор среди кандидатов не должен ронять перебор.
    }
  }
  return null
}
