import { ANSWER_MAX_CHARS, type FormQuestion } from './types.js'
import type { Config, ResumeConfig } from '../config/schema.js'

/**
 * Delimiters rather than JSON, for the reason letters use them: answers can span
 * lines, and a raw newline inside a JSON string broke whole batches of letters.
 */
export const ANSWER_DELIMITER = (n: number) => `###ОТВЕТ ${n}###`
export const UNKNOWN_DELIMITER = (n: number) => `###НЕ ЗНАЮ ${n}###`

/**
 * The first three rules are the owner's, carried over verbatim from his message
 * (05.10) and not to be softened into generic advice. The rest is plumbing: how a
 * choice is written down, and the escape hatch — a form the model cannot answer is
 * parked for the owner rather than guessed at.
 */
export function systemPrompt(): string {
  return [
    'Ты заполняешь от имени кандидата форму с вопросами работодателя при отклике на',
    'вакансию на hh.ru. Отвечай на русском, от первого лица.',
    '',
    'Есть несколько правил для твоих ответов:',
    '1. не используй длинное тире, это сразу выдает, что ответ писал не человек. Пиши',
    '   человекоподобно, без специальных символов, которых нет на клавиатуре.',
    '2. Старайся писать кратко и ёмко по смыслу, не нужно писать очень длинные ответы.',
    `   Предел - ${ANSWER_MAX_CHARS} символов для одного ответа.`,
    '3. Если вопрос такой, что для ответа одного резюме недостаточно - например,',
    '   "расскажите, на каких проектах вы использовали Pinia?" - можно придумать хороший',
    '   ответ самостоятельно, но только так, чтобы он матчился с резюме.',
    '',
    'Ещё:',
    '- Никогда не пиши, что кандидат чего-то не знает, с чем-то не работал или что у него',
    '  нет опыта. Кандидат должен выглядеть подходящим на эту вакансию.',
    '- Без markdown, без списков, без подписи.',
    '- На анкетные вопросы (зарплата, город, гражданство, образование, формат работы, оформление и т.п.)',
    '  отвечай строго по анкете кандидата ниже, ничего не меняя по смыслу.',
    '- В вопросах с вариантами выбирай вариант, который лучше всего соответствует резюме',
    '  и анкете кандидата, в пользу кандидата.',
    '- Если ответа нет ни в резюме, ни в анкете и придумать его нельзя (личные данные:',
    '  учебное заведение, возраст, дата выхода и подобное), не выдумывай,',
    '  а пиши для этого вопроса разделитель "НЕ ЗНАЮ" и причину.',
  ].join('\n')
}

export interface FormPromptInput {
  vacancy: { title: string; company: string | null; description: string | null }
  salary: string
  questions: readonly FormQuestion[]
  resume: ResumeConfig
  resumeText: string
}

export function formPrompt(input: FormPromptInput, cfg: Config): string {
  const extra = cfg.letter.extraSkills.trim()
  const { vacancy } = input

  const questions = input.questions
    .map((q) => {
      const head = `${q.index}. [${KIND_LABEL[q.kind]}] ${q.text}`
      if (q.kind === 'text') return head
      const opts = q.options.map((o, i) => `   ${i + 1}) ${o.label}`).join('\n')
      return `${head}\n${opts}`
    })
    .join('\n\n')

  return [
    `Резюме кандидата (стек «${input.resume.id}»):`,
    input.resumeText.trim(),
    ...(extra ? ['', 'Дополнительно, сверх резюме:', extra] : []),
    '',
    'Анкета кандидата:',
    ...cfg.profile.facts.map((f) => `- ${f}`),
    `- Желаемая зарплата для этой вакансии: ${input.salary}. На любой вопрос о зарплате,`,
    '  доходе или ожиданиях отвечай этой суммой.',
    '',
    `Вакансия: ${vacancy.title}${vacancy.company ? ` - ${vacancy.company}` : ''}`,
    ...(vacancy.description ? [collapse(vacancy.description).slice(0, 1500)] : []),
    '',
    'Вопросы формы:',
    '',
    questions,
    '',
    'Формат ответа - строго такой, без JSON и без пояснений, разделитель перед каждым ответом:',
    '',
    ANSWER_DELIMITER(1),
    'текст ответа на текстовый вопрос',
    '',
    ANSWER_DELIMITER(2),
    'номер одного варианта (для вопроса с одним вариантом), например: 2',
    '',
    ANSWER_DELIMITER(3),
    'номера вариантов через запятую (для вопроса с несколькими вариантами), например: 1, 3',
    '',
    'Если выбран вариант "Свой вариант" - номер на первой строке, а текст своего варианта',
    'на следующей строке.',
    '',
    'Если на вопрос ответить нельзя:',
    UNKNOWN_DELIMITER(4),
    'почему',
    '',
    `Ответь на все ${input.questions.length} вопросов, номер разделителя совпадает с номером вопроса.`,
  ].join('\n')
}

const KIND_LABEL: Record<FormQuestion['kind'], string> = {
  text: 'текст',
  radio: 'один вариант',
  checkbox: 'несколько вариантов',
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
