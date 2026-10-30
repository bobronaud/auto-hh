import type { CollectStats } from '../hh/search.js'
import type { ApplyOutcome } from '../hh/apply.js'
import type { AlarmSource, Repo } from '../db/repo.js'
import type { logger } from '../core/logger.js'

type Logger = ReturnType<typeof logger>

/**
 * Tripwires: signs, inside an ordinary run, that hh's markup moved under selectors.ts.
 *
 * Why they exist: between 27.10 and 29.10 the chat bubbles changed markup, and the chat
 * run kept finishing "ok" with all zeros for days. A run that does nothing looks the
 * same as a run with nothing to do — unless something says which one it was. Every
 * alarm names the selectors to look at; all of them are pure so tests can pin them.
 */

/** Share of cards on the search page that may fail to parse before it is a selector. */
const MAX_UNPARSED_SHARE = 0.2

export function collectAlarms(stats: CollectStats): string[] {
  const out: string[] = []
  if (stats.pages > 0 && stats.parsedCards === 0) {
    out.push(
      stats.domCards === 0
        ? 'сбор: на первой странице выдачи ни одной карточки — проверьте selectors.search.card'
        : `сбор: карточек на странице ${stats.domCards}, но ни одна не разобралась — selectors.search.cardTitleLink`,
    )
    return out
  }
  if (stats.domCards > 0 && (stats.domCards - stats.parsedCards) / stats.domCards > MAX_UNPARSED_SHARE) {
    out.push(
      `сбор: из ${stats.domCards} карточек разобралось ${stats.parsedCards} — у остальных нет ссылки или ` +
        'заголовка, selectors.search.cardTitleLink',
    )
  }
  if (stats.parsedCards >= 10 && stats.withCompany === 0) {
    out.push(`сбор: ни у одной из ${stats.parsedCards} карточек нет работодателя — selectors.search.cardCompany`)
  }
  return out
}

/**
 * Outcomes that, in a row, point at a selector rather than at the vacancies. Each one
 * alone is ordinary — a closed vacancy has no apply button — but three in a row from a
 * queue sorted by "had an apply button in the card" is the markup.
 *
 * `no_apply_button` matters most: it writes `skipped`, and a skipped vacancy never
 * returns to the queue (invariant 11). A broken apply-button selector would write the
 * whole queue off in one run.
 */
export function suspectOutcome(o: ApplyOutcome): string | null {
  switch (o.status) {
    case 'skipped':
      return o.reason === 'no_apply_button' ? 'нет кнопки «Откликнуться» (selectors.vacancy.applyButton)' : null
    case 'needs_human':
      return o.reason === 'unrecognised_form' ? 'форма отклика не распознана (selectors.apply.*)' : null
    case 'failed':
      return SUSPECT_FAILURES[o.errorCode] ?? null
    default:
      return null
  }
}

const SUSPECT_FAILURES: Record<string, string> = {
  unknown_state: 'клик «Откликнуться» ни к чему не привёл (selectors.apply.modal)',
  no_success_confirmation: 'нет подтверждения отправки (selectors.apply.success)',
  resume_select_failed: 'не выбрано резюме (selectors.apply.resumeSelect / resumeOption)',
  no_submit_button: 'нет кнопки отправки (selectors.apply.submitButton)',
  no_letter_toggle: 'нет переключателя письма (selectors.apply.letterToggle)',
  no_letter_field: 'нет поля письма (selectors.apply.letterTextarea)',
  letter_not_entered: 'письмо не вписалось в поле (selectors.apply.letterTextarea)',
  form_fill_failed: 'форма вопросов не заполнилась (selectors.responseForm.*)',
  exception: 'исключение в отклике',
}

/** Suspect outcomes in a row before the run stops. */
export const SUSPECT_STREAK_LIMIT = 3

/**
 * Feed outcomes one by one; returns the alarm text once the streak reaches the limit.
 * Any ordinary outcome — applied, parked for questions, archived — resets it.
 */
export class SuspectStreak {
  private run: string[] = []

  push(o: ApplyOutcome): string | null {
    const why = suspectOutcome(o)
    if (!why) {
      this.run = []
      return null
    }
    this.run.push(why)
    if (this.run.length < SUSPECT_STREAK_LIMIT) return null
    const kinds = [...new Set(this.run)].join('; ')
    return `отклики: ${this.run.length} подозрительных исхода подряд — ${kinds}. Прогон остановлен, чтобы не списать очередь`
  }
}

/** Log and store; the dashboard shows open alarms until a green check resolves them. */
export function raiseAlarms(repo: Repo, log: Logger, source: AlarmSource, messages: readonly string[]): void {
  for (const m of messages) {
    log.error(`⚠ ${m} — нажмите «проверить селекторы»`)
    repo.recordAlarm(source, m)
  }
}
