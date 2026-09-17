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
    /**
     * Зарплата есть не у всех вакансий — отсутствие в конкретной карточке не значит,
     * что селектор неверен. Но в выгрузке её не было ни в одной из 50 карточек,
     * так что проверять оба варианта имени.
     */
    cardSalary: [
      '[data-qa="vacancy-serp__vacancy-compensation"]',
      '[data-qa="vacancy-serp__vacancy_compensation"]',
      '[data-qa*="compensation"]',
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
    /**
     * hh пагинирует ссылками на страницы, без кнопки «вперёд». Ходим по &page=N
     * напрямую (searchUrl.ts) — эти селекторы нужны только чтобы понять, есть ли
     * ещё страницы.
     */
    pagerBlock: ['[data-qa="pager-block"]'],
    pagerPage: ['[data-qa="pager-page"]'],
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
   * Отклик. У hh ДВА разных потока, подтверждено пробой:
   *
   *   A. Модалка (простая вакансия): div[role="dialog"] с дропдауном резюме,
   *      кнопкой «Добавить сопроводительное» и отправкой — всё на месте.
   *   B. Отдельная страница /applicant/vacancy_response (вакансия с вопросами
   *      работодателя или тестовым): модалки нет вообще, форма открывается
   *      страницей. Именно сюда попала вторая проба.
   *
   * Поток B автоматизации не подлежит: вопросы работодателя — свободный текст,
   * который должен писать человек. Такие вакансии помечаются needs_human и
   * откладываются в UI (см. applyFlow.ts).
   */
  apply: {
    modal: ['[data-qa="vacancy-response-popup"]', 'div[role="dialog"]'],
    /**
     * Дропдаун резюме. Подтверждено выгрузкой: это НЕ select и не combobox, а
     * div[role="button"], внутри которого лежит [data-qa="resume-title"].
     * Классы у hh хешированные (magritte-select-layout___3THUn_13-0-4) — на них
     * опираться нельзя, они меняются с каждой сборкой.
     */
    resumeSelect: [
      'div[role="dialog"] [role="button"]:has([data-qa="resume-title"])',
      '[data-qa="resume-select"]',
    ],
    /** Название выбранного резюме — по нему сверяем, что выбрали нужное. */
    resumeTitle: ['[data-qa="resume-title"]'],
    /** Пункты раскрытого списка. Могут рендериться в портале ВНЕ модалки. */
    resumeOption: [
      '[data-qa="resume-select-option"]',
      '[role="option"]',
      '[role="listbox"] [role="button"]',
      '[role="menu"] [role="menuitem"]',
    ],
    /** Подтверждено выгрузкой: data-qa не «vacancy-response-letter-toggle». */
    letterToggle: [
      '[data-qa="add-cover-letter"]',
      'button:has-text("Добавить сопроводительное")',
    ],

    /**
     * ⚠️ Резюме скрыто от работодателей — отклик не пройдёт (§1.3,
     * resume_visibility_conflict).
     *
     * Элемент присутствует в DOM ВСЕГДА: это collapsible со style="max-height: 0px",
     * когда предупреждения нет. Проверять только видимость, не существование —
     * иначе каждая вакансия будет выглядеть заблокированной.
     */
    hiddenResumeWarning: ['[data-qa="hidden-resume-warning"]'],
    /** Подтверждено пробой. maxlength у поля НЕТ — лимит длины замерять вручную. */
    letterTextarea: [
      '[data-qa="vacancy-response-popup-form-letter-input"]',
      'textarea[data-qa*="letter"]',
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
      'text=/Вы откликнулись/i',
    ],

    /**
     * --- Признаки потока B: дальше нужен человек ---
     *
     * ⚠️ Эти селекторы применяются ТОЛЬКО внутри формы отклика или модалки
     * (applyFlow.ts, hasWithin). По всей странице их искать нельзя: описание
     * вакансии сплошь и рядом содержит «тестовое задание» как рассказ о процессе
     * найма, и обычная вакансия помечалась бы как неавтоматизируемая.
     */
    employerQuestions: [
      '[data-qa="vacancy-response-questions"]',
      '[data-qa*="question"]',
      'textarea[name*="question"]',
      'text=/Вопросы работодателя/i',
      'text=/Ответьте на вопрос/i',
    ],
    testRedirect: [
      '[data-qa="vacancy-test"]',
      '[data-qa*="test-section"]',
      'text=/пройти тест/i',
      'text=/начать тестирование/i',
    ],
    relocationWarning: ['text=/готовы к переезду/i', 'text=/подтвердите готовность/i'],

    /** --- Ошибки (§1.3) --- */
    limitExceeded: [
      'text=/лимит откликов/i',
      'text=/превышено количество откликов/i',
      'text=/больше откликов сегодня/i',
    ],
    tooLongMessage: ['text=/слишком длинн/i', 'text=/превышена длина/i'],
    alreadyAppliedNotice: ['text=/Вы уже откликались/i', 'text=/Вы откликнулись/i'],
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
