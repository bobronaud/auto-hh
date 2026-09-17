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

/**
 * The system prompt carries the rules; the user prompt carries the data.
 *
 * Two constraints do real work here. "Invent nothing" is the important one: a letter
 * claiming experience the resume does not list is worse than no letter at all — it is
 * read by a person who will ask about it. The length cap is the other: hh rejects
 * over-long letters outright (too_long_message).
 */
export function systemPrompt(cfg: Config): string {
  const lang = cfg.letter.language === 'ru' ? 'русском' : 'английском'
  return [
    `Ты пишешь сопроводительные письма к откликам на вакансии на ${lang} языке.`,
    '',
    'Жёсткие правила:',
    `— Не более ${cfg.letter.maxChars} символов в каждом письме, цель — ${Math.round(cfg.letter.maxChars * 0.4)}.`,
    '— НИКОГДА не приписывай кандидату опыт, которого нет в резюме. Ни технологий, ни лет, ни компаний.',
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
): string {
  const vacancies = targets
    .map((t) => {
      const head = `${t.index}. ${t.title}${t.company ? ` — ${t.company}` : ''}`
      // A trimmed description still anchors the letter; the full text would blow the
      // batch out for no gain.
      const desc = t.description ? `\n   ${collapse(t.description).slice(0, 700)}` : ''
      return head + desc
    })
    .join('\n')

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
