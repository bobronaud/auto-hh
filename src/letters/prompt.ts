import type { Config, ResumeConfig } from '../config/schema.js'

/** Bump when the wording changes, so stored letters stay attributable. */
export const PROMPT_VERSION = 'v2'

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
 * The grounding rule is aimed at fabricated *specifics* — metrics, durations, company
 * names, job titles — because those are checkable and a person will ask about them.
 * It is deliberately NOT a ban on everything absent from the file: a resume is an
 * edited document, and its author may well know more than it lists. The resume file is
 * the pool of material to draw on, not an exhaustive account of the candidate.
 *
 * The length cap is the other real constraint: hh rejects over-long letters outright
 * (too_long_message).
 */
export function systemPrompt(cfg: Config): string {
  const lang = cfg.letter.language === 'ru' ? 'русском' : 'английском'
  return [
    `Ты пишешь сопроводительные письма к откликам на вакансии на ${lang} языке.`,
    '',
    'Жёсткие правила:',
    `— Не более ${cfg.letter.maxChars} символов в каждом письме, цель — ${Math.round(cfg.letter.maxChars * 0.4)}.`,
    '— Не выдумывай проверяемых фактов: цифр, метрик, сроков, названий компаний и должностей.',
    '  Любая конкретика в письме должна браться из резюме дословно или близко к тексту.',
    '— Зарплату и отсутствие ссылок упоминай ТОЛЬКО там, где это указано в задании к вакансии.',
    '  Не додумывай эти темы сам и не переноси их из одной вакансии в другую.',
    '— Опирайся на 1-2 конкретные детали вакансии: стек, продукт, задачу. Общие фразы не нужны.',
    '— Без markdown, без заголовков, без списков. Только текст письма.',
    '— Не выдумывай имя кандидата и не подписывайся именем.',
    '— Не повторяй одну и ту же формулировку в разных письмах.',
    '',
    'Плохое письмо: перечисление качеств «ответственный, целеустремлённый».',
    'Хорошее письмо: чем именно опыт кандидата пересекается с этой вакансией.',
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

  return [
    `Резюме кандидата (стек «${resume.id}»):`,
    resumeText.trim(),
    '',
    `Напиши ${targets.length} писем — по одному на каждую вакансию ниже.`,
    `Каждое письмо не длиннее ${cfg.letter.maxChars} символов.`,
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

/** 200000 -> "200 000 ₽". Тонкая неразрывная шпация, как пишет hh. */
function formatSalary(n: number): string {
  return `${n.toLocaleString('ru-RU').replace(/\u00a0/g, '\u202f')}\u202f₽`
}
