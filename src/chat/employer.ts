import { createProvider, type LlmProvider } from '../llm/provider.js'
import { logger } from '../core/logger.js'
import type { Config } from '../config/schema.js'

const log = logger('chat')

export const AUTO_DELIMITER = '###РАССЫЛКА###'
export const PERSONAL_DELIMITER = '###РЕКРУТЕР###'

/**
 * Is this employer message a mass mailing nobody has to read, or a recruiter writing
 * to the owner? Decided by the model, not by keywords (owner, 06.10): a recruiter can
 * write something important without a question mark — "напишите мне в телеграм",
 * "пришлите паспортные данные" — and a regex has no way to tell that from "мы
 * свяжемся с вами".
 *
 * Errs towards the owner: a model failure, an off-format reply or a doubt all mean
 * "recruiter". A mailing shown to the owner costs a click; a recruiter hidden from him
 * costs the job.
 */
export function employerSystemPrompt(): string {
  return [
    'Ты разбираешь сообщения работодателя кандидату в чате hh.ru после отклика на вакансию',
    'и решаешь, нужно ли кандидату самому их прочитать.',
    '',
    `${AUTO_DELIMITER} - автоматическое или шаблонное уведомление, которое ничего не просит и`,
    'ничего нового не сообщает: отказ, вакансия или позиция закрыта, "резюме получено",',
    '"рассмотрим ваше резюме и свяжемся", "взяли резюме в работу", "вернемся с обратной связью".',
    '',
    `${PERSONAL_DELIMITER} - всё остальное: работодатель что-то спрашивает или просит (написать`,
    'в телеграм, прислать данные, резюме, портфолио, выполнить тестовое), приглашает на',
    'собеседование или созвон, предлагает следующий шаг, уточняет условия, сообщает что-то',
    'конкретное о вакансии. Неважно, есть ли в сообщении вопросительный знак.',
    '',
    `Если сомневаешься - ${PERSONAL_DELIMITER}.`,
    '',
    'Ответ - одна строка: разделитель и через пробел короткая причина.',
  ].join('\n')
}

export function employerPrompt(text: string): string {
  return ['Сообщение работодателя:', '', text.trim()].join('\n')
}

export type EmployerVerdict = { auto: boolean; reason: string }

export async function classifyEmployerMessage(
  text: string,
  cfg: Config,
  provider: LlmProvider = createProvider(cfg),
): Promise<EmployerVerdict> {
  try {
    const result = await provider.complete({ system: employerSystemPrompt(), prompt: employerPrompt(text) })
    log.debug(`employer message verdict, raw: ${result.text}`)
    return interpretVerdict(result.text)
  } catch (e) {
    return { auto: false, reason: `LLM не ответила: ${(e as Error).message}` }
  }
}

export function interpretVerdict(raw: string): EmployerVerdict {
  const personal = /###\s*РЕКРУТЕР\s*###/iu.exec(raw)
  const auto = /###\s*РАССЫЛКА\s*###/iu.exec(raw)
  const reason = raw.replace(/###[^#]*###/gu, '').replace(/\s+/g, ' ').trim()
  // Both, or neither: not a verdict — keep it for the owner.
  if (auto && !personal) return { auto: true, reason }
  return { auto: false, reason: personal ? reason : `ответ не по формату: ${raw.slice(0, 80)}` }
}
