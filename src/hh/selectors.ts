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

  /**
   * Антибот. Ловим, останавливаемся, зовём человека (§2.2). Никогда не решаем сами.
   *
   * ⚠️ Проверять ТОЛЬКО видимость (firstVisibleMatch), не существование. hh держит
   * невидимый iframe капчи на обычных страницах выдачи — проверка на присутствие
   * останавливала сбор на нормальной странице с вакансиями.
   */
  antibot: {
    captcha: [
      '[data-qa="account-captcha-picture"]',
      // Капча встаёт не только на входе: 22.09 hh показал её ПОСЛЕ кнопки «Отправить»
      // в модалке отклика, на 15-м отклике подряд. Прежний список ловил только
      // страницу входа и заглушку DDoS-Guard, отклик уходил в no_success_confirmation,
      // и прогон шёл дальше — 63 вакансии подряд в мусор. Первый кандидат подтверждён
      // живым дампом (data/probe/captcha-submit-*.html); остальные — широкая страховка
      // по подстроке на случай другой вёрстки.
      '[data-qa*="captcha"]',
      'input[name*="captcha" i]',
      'img[src*="captcha"]',
      '#ddg-captcha',
      'form[action*="captcha"]',
      'iframe[src*="smartcaptcha"]',
      'iframe[src*="captcha"]',
    ],
    /**
     * Текст капчи — ТОЛЬКО внутри оверлея (captchaScope), никогда по документу.
     * Страница вакансии под модалкой никуда не девается, а её описание — ровно тот
     * текст, на котором горели прошлые детекторы (грабли §2.2).
     */
    captchaText: [
      'text=/Пройдите капчу/i',
      'text=/введите текст с картинки/i',
      'text=/вы не робот/i',
    ],
    /**
     * Части диалога «Пройдите капчу» для автоввода (05.10). Сняты с живого дампа
     * data/probe/captcha-submit-*.html: диалог встаёт поверх модалки отклика.
     */
    captchaPicture: ['img[data-qa="account-captcha-picture"]', 'img[src*="/captcha/picture"]'],
    captchaInput: ['input[data-qa="account-captcha-input"]', 'input[name="captchaText"]'],
    /**
     * «Отправить» капчи — submit в той же форме, что и поле. Модалка отклика под ней
     * тоже имеет submit, поэтому ищем только рядом с полем капчи.
     */
    captchaSubmit: [
      'form:has(input[data-qa="account-captcha-input"]) button[type="submit"]',
      'form:has(input[name="captchaText"]) button[type="submit"]',
    ],
    /** «Другой текст» — новая картинка, когда эту прочитать не удалось. */
    captchaRenew: ['[data-qa="captcha-renew-text"]'],
    /**
     * «Неверный текст. Пожалуйста, повторите попытку.» Лежит в DOM всегда, под обёрткой
     * aria-hidden="true" — показанной считается только без неё (captcha.ts, errorShown).
     */
    captchaError: ['[data-qa="account-captcha-error"]'],
    /** Контейнеры, в которых hh показывает капчу поверх страницы. */
    captchaScope: [
      'div[role="dialog"]',
      '[data-qa*="modal"]',
      '[class*="modal-overlay"]',
      '[class*="magritte-modal"]',
    ],
    /**
     * ⚠️ Только текстовые признаки — применять ИСКЛЮЧИТЕЛЬНО на странице без
     * интерфейса hh (см. looksLikeHhPage в browser.ts). Настоящая заглушка
     * DDoS-Guard это голая страница; на живой выдаче «DDoS-Guard» встречается как
     * название компании-работодателя, и поиск по документу останавливал сбор.
     */
    ddosGuard: ['text=/DDoS-?Guard/i', 'text=/проверка вашего браузера/i'],
    blocked: ['text=/Доступ ограничен/i', 'text=/слишком много запросов/i'],
  },

  /**
   * Признаки того, что перед нами вообще страница hh, а не заглушка антибота.
   * Хватает любого — шапка есть на всех страницах сайта.
   */
  hhChrome: [
    '[data-qa="mainmenu_vacancySearch"]',
    '[data-qa="mainmenu_applicantProfile"]',
    'header [data-qa]',
    '[data-qa="vacancy-serp__results"]',
    '[data-qa="vacancy-title"]',
  ],

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
     * «Вы откликнулись» прямо в карточке. hh знает об откликах больше нашей БД —
     * например о сделанных руками или с телефона. Дешевле поверить ему здесь, чем
     * открыть вакансию и упереться в отказ.
     */
    cardAlreadyApplied: ['[data-qa="vacancy-serp__vacancy-response-link"]', 'text=/Вы откликнулись/i'],
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
    /** «Опыт работы: 1–3 года». Подтверждено разведкой форм (05.10). */
    experience: ['[data-qa="vacancy-experience"]'],
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
   * Поток B автоматизирован с 05.10 (решение владельца): вопросы работодателя
   * заполняются по responseForm ниже, ответы пишет LLM. Ручным остаётся только
   * отдельный тест hh (testRedirect).
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
      // Страница отклика с вопросами: тот же дропдаун, но без модалки вокруг.
      'main form [role="button"]:has([data-qa="resume-title"])',
      '[data-qa="resume-select"]',
    ],
    /** Название выбранного резюме — по нему сверяем, что выбрали нужное. */
    resumeTitle: ['[data-qa="resume-title"]'],
    /**
     * Пункты раскрытого списка. Подтверждено выгрузкой: это НЕ role="option", а
     * радио-список, рендерится в портале ВНЕ модалки — искать по всей странице.
     *
     *   <div data-qa="cell">
     *     <span data-qa="radio-container"><input type="radio" value="<id резюме>">
     *     <div data-qa="resume-title">…<div data-qa="cell-text-content">Название
     */
    // Варианты ответов на вопросы работодателя размечены ТАК ЖЕ (cell + radio-container),
    // поэтому всё, что внутри task-body, исключено: иначе «Да»/«Нет» попадали бы в
    // список резюме.
    resumeOption: [
      '[data-qa="cell"]:has([data-qa="radio-container"]):not([data-qa="task-body"] [data-qa="cell"])',
    ],
    /** Текст названия внутри пункта — по нему выбираем нужное резюме. */
    resumeOptionText: ['[data-qa="cell-text-content"]'],
    /** value радио-инпута — стабильный id резюме, переживает переименование. */
    resumeOptionInput: ['[data-qa="radio-container"] input[type="radio"]'],
    /** Подтверждено выгрузкой: data-qa не «vacancy-response-letter-toggle». */
    letterToggle: [
      '[data-qa="add-cover-letter"]',
      // Страница отклика с вопросами: «Сопроводительное письмо · Добавить».
      '[data-qa="vacancy-response-letter-toggle"]',
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
      // hh говорит об одном и том же событии тремя способами, и разница между
      // «отправлено» и «доставлено» стоила одного отклика, записанного как
      // неуспешный: письмо ушло, подтверждение на странице было, совпадения не было.
      'text=/(Отклик|Резюме) (отправлен|доставлен)[оа]?/i',
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
      // «…необходимо ответить на несколько вопросов работодателя» — падеж другой,
      // чем в заголовке. Явный кириллический класс, не \w: \w в JS — только ASCII.
      'text=/вопрос[а-яё]* работодателя/i',
    ],
    testRedirect: [
      '[data-qa="vacancy-test"]',
      '[data-qa*="test-section"]',
      'text=/пройти тест/i',
      'text=/начать тестирование/i',
    ],
    relocationWarning: ['text=/готовы к переезду/i', 'text=/подтвердите готовность/i'],

    /**
     * «Вы откликаетесь на вакансию в другой стране» — предупреждение перед формой
     * отклика, две кнопки: «Все равно откликнуться» и «Отменить». Это НЕ повод
     * звать человека: цель — максимум откликов, отказ работодателя дешевле
     * неотправленного отклика. Жмём подтверждение и продолжаем обычный поток.
     *
     * Диалог не имеет role="dialog" — apply.modal его не ловит, и вакансия падала
     * в blocked/unknown_state (137448033, 18.09). Опознаём по самой кнопке.
     *
     * ⚠️ «Все» и «Всё» — разные строки, has-text сравнивает буквально. Держим оба.
     */
    confirmOtherCountry: [
      '[data-qa="vacancy-response-confirm"]',
      'button:has-text("Все равно откликнуться")',
      'button:has-text("Всё равно откликнуться")',
      '[role="button"]:has-text("Все равно откликнуться")',
      '[role="button"]:has-text("Всё равно откликнуться")',
    ],

    /** --- Ошибки (§1.3) --- */
    limitExceeded: [
      'text=/лимит откликов/i',
      'text=/превышено количество откликов/i',
      'text=/больше откликов сегодня/i',
    ],
    tooLongMessage: ['text=/слишком длинн/i', 'text=/превышена длина/i'],
    alreadyAppliedNotice: ['text=/Вы уже откликались/i', 'text=/Вы откликнулись/i'],
  },

  /**
   * Форма вопросов работодателя на /applicant/vacancy_response. Снято с живых дампов
   * (data/probe/form-*.html, 05.10):
   *
   *   <div data-qa="task-body">
   *     <div data-qa="task-question">Текст вопроса</div>
   *     текст:  <textarea name="task_<id>_text">
   *     радио:  <label data-qa="cell"><input type="radio" name="task_<id>" value="<opt>">
   *             <span data-qa="cell-text-content">Да</span></label> …
   *             «Свой вариант» — value="open" плюс textarea task_<id>_text
   *
   * Ниже формы — тот же дропдаун резюме, переключатель письма
   * vacancy-response-letter-toggle и кнопка vacancy-response-submit-popup.
   * Чекбоксов в дампах не было; разбираются по той же схеме, что радио.
   */
  responseForm: {
    question: ['[data-qa="task-body"]'],
    questionText: ['[data-qa="task-question"]'],
    optionText: ['[data-qa="cell-text-content"]'],
  },

  /**
   * Чат с работодателем (chatik), hh.ru/chat и hh.ru/chat/<id>. Снято с живых дампов
   * data/probe/chat-*.html (05.10); урезанная копия — test/fixtures/chat-open.html.
   * Живёт в основном документе, не в iframe.
   *
   * Сообщение — [data-qa="chatik-chat-message-<id>"]; внутри либо пузырь
   * (chat-bubble-wrapper), либо системная строка participant-action-message-N
   * («Пользователь ИИ-помощник присоединился к чату / покинул чат»).
   * Своё от чужого — по статусу доставки, см. ownMark.
   * Имя автора (chat-bubble-author-name, «ИИ-помощник») стоит только у ПЕРВОГО
   * сообщения серии — для следующих автор переносится.
   * Кнопки «отправить» в дампе нет: при пустом поле на её месте запись голоса.
   * Кандидаты ниже — догадки, при отсутствии отправляем Enter.
   */
  chat: {
    onlyUnread: ['input[data-qa="chatik-checkbox-only-unread"]'],
    /** Сам input скрыт под отрисованным чекбоксом, кликается подпись вокруг него. */
    onlyUnreadLabel: ['label:has(input[data-qa="chatik-checkbox-only-unread"])'],
    listSkeleton: ['[data-qa="chats-list-skeleton-wrapper"]'],
    /** Ссылка на чат в списке; id — в хвосте data-qa и в href /chat/<id>. */
    listItem: ['a[data-qa^="chatik-open-chat-"]'],
    listTitle: ['[data-qa="chat-cell-title"]'],
    listCompany: ['[data-qa="chat-cell-subtitle"]'],
    message: ['[data-qa^="chatik-chat-message-"]:not([data-qa$="-text"])'],
    systemMessage: ['[data-qa^="participant-action-message"]'],
    bubble: ['[data-qa="chat-bubble-wrapper"]'],
    bubbleText: ['[data-qa="chat-bubble-text"]'],
    bubbleTitle: ['[data-qa="chat-bubble-title"]'],
    authorName: ['[data-qa="chat-bubble-author-name"]'],
    /**
     * Статус доставки есть только у своих: chat-bubble-icon-delivered, -read. У чужих
     * иконки либо нет (отказ работодателя), либо chat-bubble-icon-hidden — поэтому
     * своё узнаётся по наличию статуса, а не чужое по icon-hidden.
     */
    ownMark: [
      '[data-qa^="chat-bubble-icon-"]:not([data-qa="chat-bubble-icon-hidden"])',
      '[data-qa="desktop-message-menu"]',
    ],
    headerTitle: ['[data-qa="participant-info-title"]'],
    /** «Вакансия» + название + «Перейти» одним текстом. */
    headerVacancy: ['[data-qa="chatik-header-sub-header"]'],
    vacancyLink: ['a[data-qa="chatik-header-vacancy-link"]'],
    input: ['[data-qa="chatik-message-input"] textarea', 'textarea[data-qa="text-input"]'],
    send: [
      '[data-qa="chatik-message-input"] button[aria-label*="Отправить"]',
      '[data-qa="chatik-do-send-message"]',
      '[data-qa="chat-input-send"]',
      '[data-qa="chatik-message-input"] [data-qa*="send"]',
    ],
  },
} as const

/**
 * Первый кандидат, который реально ВИДЕН на странице.
 *
 * Отличать от firstMatch: на hh полно узлов, которые присутствуют в DOM постоянно и
 * ничего не значат — невидимый iframe капчи, схлопнутые предупреждения. Для всего,
 * что останавливает работу, проверять надо именно видимость.
 */
export async function firstVisibleMatch(
  page: {
    locator: (s: string) => {
      first: () => {
        count: () => Promise<number>
        isVisible: () => Promise<boolean>
        boundingBox: () => Promise<{ width: number; height: number } | null>
      }
    }
  },
  candidates: SelectorCandidates,
): Promise<string | null> {
  for (const s of candidates) {
    try {
      const loc = page.locator(s).first()
      if ((await loc.count()) === 0) continue
      if (!(await loc.isVisible())) continue
      const box = await loc.boundingBox()
      if (box && box.width > 0 && box.height > 0) return s
    } catch {
      // Невалидный селектор среди кандидатов не должен ронять перебор.
    }
  }
  return null
}

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
