import type { Config, ResumeConfig } from '../config/schema.js'

/** Bump when the wording changes, so stored letters stay attributable. */
export const PROMPT_VERSION = 'v3'

/**
 * Letters are returned between plain-text delimiters, not as JSON.
 *
 * JSON was the obvious first choice and the wrong one: letters have paragraphs, a raw
 * newline inside a JSON string literal is invalid JSON, and the whole batch failed to
 * parse. Asking the model to emit \n escapes just moves the problem onto it. With
 * delimiters, line breaks are ordinary text and there is nothing to escape.
 */
export const LETTER_DELIMITER = (n: number) => `###ПИСЬМО ${n}###`

export interface LetterTarget {
  index: number
  title: string
  company: string | null
  /** Trimmed vacancy description, when we have one. */
  description?: string | null
}

/** Per-vacancy instructions derived from what the posting asks for. */
export interface TargetHints {
  /** Salary to name, in roubles, when the posting asked for expectations. */
  salary?: number
  /** The posting asked for links we do not have. */
  explainNoLinks?: boolean
}

/**
 * The system prompt carries the rules; the user prompt carries the data.
 *
 * The rules are the owner's own, carried over from the prompt he used by hand in
 * claude.ai — they are not generic "write a good letter" advice and should not be
 * softened into it:
 *
 *   - It has to read as written by a person. That is mostly a typography rule: an em
 *     dash is the single clearest tell, because nobody types one on a keyboard.
 *     `validate.ts` enforces this, `tidyLetter` repairs it.
 *   - It has to be motivated. A letter that could have been sent to any vacancy is
 *     a wasted letter, so it hangs on one or two specifics of this posting.
 *   - It has to be short. Long letters do not get read; the cap is 1000 characters
 *     and the target is well under it.
 *   - It must never admit a gap. A recruiter reading "не работал с Angular, но быстро
 *     разберусь" stops reading; a technology absent from the resume simply goes
 *     unmentioned.
 *   - It must not sign off. The letter travels attached to the resume, which already
 *     carries the name and the contacts.
 *
 * The grounding rule is aimed at fabricated *specifics* — metrics, durations, company
 * names, job titles — because those are checkable and a person will ask about them.
 * It is deliberately NOT a ban on everything absent from the file: a resume is an
 * edited document, and its author may well know more than it lists. The resume file is
 * the pool of material to draw on, not an exhaustive account of the candidate.
 */
export function systemPrompt(cfg: Config): string {
  const lang = cfg.letter.language === 'ru' ? 'русском' : 'английском'
  const target = Math.round(cfg.letter.maxChars * 0.6)
  return [
    `Ты пишешь сопроводительные письма к откликам на вакансии на ${lang} языке,`,
    'от первого лица, от имени кандидата.',
    '',
    'Письмо должно читаться так, как его написал живой человек:',
    '— Только те символы, которые есть на клавиатуре. Длинное тире (—), короткое тире (–),',
    '  кавычки-ёлочки, типографские кавычки, многоточие одним знаком, эмодзи и любые',
    '  спецсимволы запрещены. Обычный дефис (-) и прямые кавычки (") можно.',
    '— Живая речь. Без канцелярита и без штампов вроде «коммуникабельный, стрессоустойчивый».',
    '— Без markdown, без заголовков, без списков. Сплошной текст в один-два абзаца.',
    '',
    'Что в письме должно быть:',
    '— Приветствие в начале: «Здравствуйте!». Без обращения по имени — имени мы не знаем.',
    '— Мотивация. Должно быть видно, что кандидату интересна именно эта вакансия:',
    '  зацепись за 1-2 конкретные детали из неё — продукт, стек, задачу.',
    `— Краткость. Цель — ${target} символов, жёсткий потолок — ${cfg.letter.maxChars}.`,
    '  Это 3-5 предложений, один абзац. Длинные письма никто не читает, и письмо',
    `  длиннее ${target + 100} символов — это провал задачи, а не старательность.`,
    '— Одна-две самые сильные детали, а не весь опыт подряд. Остальное есть в резюме.',
    '— Пересечение опыта кандидата с этой вакансией, а не перечисление его качеств.',
    '',
    'Чего в письме быть не должно:',
    '— Никогда не пиши, что кандидат чего-то не знает, с чем-то не работал, что у него',
    '  нет опыта или что он «быстро освоит». В глазах читающего кандидат должен выглядеть',
    '  идеальным на эту вакансию. Технологию, которой нет в резюме, просто не упоминай.',
    '— Ни имени, ни подписи, ни контактов в конце. Письмо идёт вместе с резюме,',
    '  рекрутер видит там и имя, и контакты.',
    '— Не выдумывай проверяемых фактов: цифр, метрик, сроков, названий компаний и должностей.',
    '  Любая конкретика берётся из резюме дословно или близко к тексту.',
    '— Зарплату и отсутствие ссылок упоминай ТОЛЬКО там, где это указано в задании',
    '  к конкретной вакансии. Не додумывай эти темы и не переноси их между вакансиями.',
    '— Не повторяй одну и ту же формулировку в разных письмах.',
  ].join('\n')
}

export function batchPrompt(
  targets: readonly LetterTarget[],
  resume: ResumeConfig,
  resumeText: string,
  cfg: Config,
  hints: ReadonlyMap<number, TargetHints> = new Map(),
): string {
  const vacancies = targets
    .map((t) => {
      const head = `${t.index}. ${t.title}${t.company ? ` — ${t.company}` : ''}`
      // A trimmed description still anchors the letter; the full text would blow the
      // batch out for no gain.
      const desc = t.description ? `\n   ${collapse(t.description).slice(0, 700)}` : ''

      // Requirements go next to their own vacancy, not into the shared rules: in a
      // batch of ten only some postings ask for a salary, and a global instruction
      // would put one into every letter.
      const h = hints.get(t.index)
      const extra: string[] = []

      if (h?.salary) {
        extra.push(`   ОБЯЗАТЕЛЬНО укажи зарплатные ожидания: ${formatSalary(h.salary)}.`)
      } else {
        // The negative is stated explicitly, per vacancy, rather than left to be
        // inferred from silence. In a mixed batch the model otherwise carries the
        // topic across from the vacancies that did ask.
        extra.push('   Про зарплату НЕ пиши: эта вакансия о ней не спрашивает.')
      }

      if (h?.explainNoLinks) {
        extra.push(
          '   Вакансия просит ссылки на проекты или GitHub. Ссылок нет — кратко объясни почему, ' +
            'своими словами по смыслу: ' +
            cfg.letter.noLinksExcuse,
        )
      } else {
        extra.push(
          '   Про GitHub, портфолио и пет-проекты НЕ пиши ни слова: эта вакансия их не просит.',
        )
      }

      return [head + desc, ...extra].join('\n')
    })
    .join('\n\n')

  // The resume file is the main source; `extraSkills` carries what the file does not
  // spell out — backend work that makes a fullstack posting answerable. It is appended
  // rather than merged into the resume file, because those files are generated from the
  // PDFs actually attached to the application and must keep matching them.
  const extra = cfg.letter.extraSkills.trim()

  return [
    `Резюме кандидата (стек «${resume.id}»):`,
    resumeText.trim(),
    ...(extra ? ['', 'Дополнительно, сверх резюме:', extra] : []),
    '',
    `Напиши ${targets.length} писем — по одному на каждую вакансию ниже.`,
    `Каждое письмо — 3-5 предложений, около ${Math.round(cfg.letter.maxChars * 0.6)} символов,`,
    `и ни при каких условиях не длиннее ${cfg.letter.maxChars}.`,
    '',
    'Формат ответа — строго такой, без JSON и без пояснений:',
    '',
    LETTER_DELIMITER(1),
    'текст первого письма',
    '',
    LETTER_DELIMITER(2),
    'текст второго письма',
    '',
    'Разделитель обязателен перед каждым письмом. Номер совпадает с номером вакансии.',
    '',
    'Вакансии:',
    vacancies,
  ].join('\n')
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 200000 -> "200 000 руб".
 *
 * Plain spaces and a plain word on purpose: a thin space and the ₽ sign are exactly
 * the characters a person does not type, and `validate.ts` rejects them.
 */
function formatSalary(n: number): string {
  return `${n.toLocaleString('ru-RU').replace(/[\u00a0\u202f]/g, ' ')} руб`
}
