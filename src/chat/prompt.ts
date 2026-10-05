import { PROFILE_FACTS } from '../answers/profile.js'
import { ANSWER_MAX_CHARS } from '../answers/types.js'
import type { Config, ResumeConfig } from '../config/schema.js'
import type { ChatMessage } from './classify.js'

/** Delimiters, not JSON — the same reason letters and form answers use them. */
export const REPLY_DELIMITER = '###ОТВЕТ###'
export const UNKNOWN_DELIMITER = '###НЕ ЗНАЮ###'
export const NO_REPLY_DELIMITER = '###НЕ НУЖНО###'

/**
 * The three numbered rules are the owner's, verbatim from his message (05.10). The
 * rest mirrors answers/prompt.ts: the same candidate, the same questionnaire, the same
 * escape hatch for personal facts nobody wrote down.
 */
export function systemPrompt(): string {
  return [
    'Ты отвечаешь от имени кандидата в чате hh.ru на вопросы ИИ-помощника работодателя',
    'после отклика на вакансию. Отвечай на русском, от первого лица, только на последний',
    'вопрос помощника.',
    '',
    'Есть несколько правил для твоих ответов:',
    '1. не используй длинное тире, это сразу выдает, что ответ писал не человек. Пиши',
    '   человекоподобно, без специальных символов, которых нет на клавиатуре.',
    '2. Старайся писать кратко и ёмко по смыслу, не нужно писать очень длинные ответы.',
    `   Предел - ${ANSWER_MAX_CHARS} символов для одного ответа.`,
    '3. Если я пишу тебе вопросы, для ответа на которые одного резюме недостаточно - например,',
    '   "расскажите, на каких проектах вы использовали Pinia?" - тут я тебе разрешаю',
    '   придумывать хороший ответ самостоятельно, но только так, чтобы это матчилось с моим резюме.',
    '',
    'Ещё:',
    '- Никогда не пиши, что кандидат чего-то не знает, с чем-то не работал или что у него',
    '  нет опыта. Кандидат должен выглядеть подходящим на эту вакансию.',
    '- Без markdown, без списков, без приветствия и без подписи.',
    '- Не противоречь тому, что кандидат уже написал в этом чате.',
    '- На анкетные вопросы (зарплата, город, гражданство, образование, формат работы,',
    '  оформление и т.п.) отвечай строго по анкете кандидата, ничего не меняя по смыслу.',
    '- Если ответа нет ни в резюме, ни в анкете и придумать его нельзя (личные данные:',
    '  учебное заведение, возраст, дата выхода и подобное), не выдумывай, а пиши',
    `  разделитель ${UNKNOWN_DELIMITER} и причину.`,
  ].join('\n')
}

export interface ChatPromptInput {
  vacancy: { title: string; company: string | null; description: string | null }
  salary: string
  resume: ResumeConfig
  resumeText: string
  messages: readonly ChatMessage[]
}

const AUTHOR_LABEL: Record<ChatMessage['author'], string> = {
  me: 'Кандидат',
  assistant: 'ИИ-помощник',
  employer: 'Работодатель',
  system: 'Система',
}

export function chatPrompt(input: ChatPromptInput, cfg: Config): string {
  const extra = cfg.letter.extraSkills.trim()
  const { vacancy } = input
  const transcript = input.messages.map((m) => `${AUTHOR_LABEL[m.author]}: ${m.text.trim()}`).join('\n\n')

  return [
    `Резюме кандидата (стек «${input.resume.id}»):`,
    input.resumeText.trim(),
    ...(extra ? ['', 'Дополнительно, сверх резюме:', extra] : []),
    '',
    'Анкета кандидата:',
    ...PROFILE_FACTS.map((f) => `- ${f}`),
    `- Желаемая зарплата для этой вакансии: ${input.salary}. На любой вопрос о зарплате,`,
    '  доходе или ожиданиях отвечай этой суммой.',
    '',
    `Вакансия: ${vacancy.title}${vacancy.company ? ` - ${vacancy.company}` : ''}`,
    ...(vacancy.description ? [collapse(vacancy.description).slice(0, 1500)] : []),
    '',
    'Переписка в чате (первое сообщение кандидата - его сопроводительное письмо):',
    '',
    transcript,
    '',
    'Формат ответа - строго такой, без пояснений:',
    '',
    REPLY_DELIMITER,
    'текст ответа на последний вопрос помощника',
    '',
    'Если ответить нельзя:',
    UNKNOWN_DELIMITER,
    'почему',
    '',
    'Если последнее сообщение помощника не вопрос и отвечать на него не нужно:',
    NO_REPLY_DELIMITER,
  ].join('\n')
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
