import { useState } from 'react'
import { api, screenshotUrl, type ChatReplyRow, type DashboardState, type HistoryRow, type PendingRow } from './api'
import { CopyPath, Empty, ErrorLine, Lightbox, Modal, VacancyLink, dateTime, useFetch } from './common'

/** Pending queue, in the exact order the next run will walk it. */
export function Pending({
  version,
  state,
  onChange,
}: {
  version: number
  state: DashboardState
  onChange: () => void
}) {
  const { data, error, reload } = useFetch(() => api.pending(200), [version])
  const [busy, setBusy] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  if (error) return <ErrorLine error={error} />
  if (!data) return <Empty>загрузка…</Empty>
  if (data.rows.length === 0) return <Empty>очередь пуста — соберите вакансии</Empty>

  const llm = state.letter.mode === 'llm'

  // Dismissed for good: collect never brings it back (see repo.dismissVacancy).
  const dismiss = async (id: number): Promise<void> => {
    setBusy(id)
    setActionError(null)
    try {
      await api.dismissVacancy(id)
      reload()
      onChange()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <ErrorLine error={actionError} />
      <p className="dim">
        {data.total} вакансий ждут отклика. Порядок тот же, в котором их возьмёт прогон: сначала те,
        где в карточке была кнопка отклика, дальше по свежести объявления.
        {llm &&
          (state.letter.requireManualApproval
            ? ' Письмо можно прочитать, поправить и одобрить до отправки — без одобрения вакансия пропускается.'
            : ' Письмо уйдёт как написано: одобрение выключено, кнопка только сохраняет правки.')}
      </p>
      <table>
        <thead>
          <tr>
            <th>вакансия</th>
            <th>компания</th>
            <th>регион</th>
            <th className="num">зарплата</th>
            <th>кнопка</th>
            {llm && <th>письмо</th>}
            <th className="num">найдена</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.rows.map((v) => (
            <tr key={v.id}>
              <td>
                <VacancyLink url={v.url} title={v.title} />
                {v.has_test === 1 && <span className="badge warn" style={{ marginLeft: 8 }}>тестовое</span>}
              </td>
              <td className="dim">{v.company ?? '—'}</td>
              <td className="dim">{v.area ?? '—'}</td>
              <td className="num dim nowrap">{salary(v.salary_from, v.salary_to, v.salary_currency)}</td>
              <td className="dim">{v.can_apply_from_list === 0 ? 'нет' : v.can_apply_from_list === 1 ? 'есть' : '?'}</td>
              {llm && (
                <td>
                  <QueueLetter row={v} needsApproval={state.letter.requireManualApproval} onDone={reload} />
                </td>
              )}
              <td className="num dim nowrap">{dateTime(v.found_at)}</td>
              <td>
                <button
                  className="small danger"
                  disabled={busy !== null || !!state.run}
                  title={
                    state.run
                      ? 'идёт прогон — удалить можно после него'
                      : 'убрать из очереди насовсем: при следующем сборе не вернётся'
                  }
                  onClick={() => void dismiss(v.id)}>
                  удалить
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

const REASONS: Record<string, string> = {
  employer_questions: 'вопросы работодателя',
  test_required: 'тестовое задание',
  relocation: 'релокация',
  external_apply: 'отклик на внешнем сайте',
  unrecognised_form: 'форма не опознана',
  form_unanswered: 'не смог ответить на вопрос формы',
}

/**
 * The manual queue: hh tests, unknown shapes, and question forms the model could not
 * answer in full (form_unanswered — the question and the reason come along). Ordinary
 * question forms are answered automatically since 05.10.
 */
export function NeedsHuman({ version, onChange }: { version: number; onChange: () => void }) {
  const [includeResolved, setIncludeResolved] = useState(false)
  const { data, error, reload } = useFetch(() => api.needsHuman(includeResolved), [version, includeResolved])
  const [busy, setBusy] = useState<number | null>(null)

  const [busyAll, setBusyAll] = useState(false)

  const resolve = async (id: number): Promise<void> => {
    setBusy(id)
    try {
      await api.resolve(id)
      reload()
      onChange()
    } finally {
      setBusy(null)
    }
  }

  const resolveAll = async (): Promise<void> => {
    setBusyAll(true)
    try {
      await api.resolveAll()
      reload()
      onChange()
    } finally {
      setBusyAll(false)
    }
  }

  if (error) return <ErrorLine error={error} />
  if (!data) return <Empty>загрузка…</Empty>

  const open = data.rows.filter((r) => !r.resolved_at).length

  return (
    <>
      <p className="dim">
        Эти вакансии бот не откликнул: тестовые hh, незнакомые формы и формы с вопросами, на
        которые он не смог ответить (причина под названием). Лимит на них не тратится.{' '}
        <label style={{ marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
          />{' '}
          показывать разобранные
        </label>
      </p>
      {open > 0 && (
        <button
          className="small"
          disabled={busyAll}
          onClick={() => void resolveAll()}
          style={{ marginBottom: 10 }}
        >
          разобрал все ({open})
        </button>
      )}
      {data.rows.length === 0 ? (
        <Empty>ничего не отложено</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>вакансия</th>
              <th>компания</th>
              <th>причина</th>
              <th className="num">отложена</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.application_id}>
                <td>
                  <VacancyLink url={r.url} title={r.title} />
                </td>
                <td className="dim">{r.company ?? '—'}</td>
                <td>
                  {REASONS[r.needs_human_reason ?? ''] ?? r.needs_human_reason ?? '—'}
                  {r.error_message && <div className="dim mono">{r.error_message}</div>}
                </td>
                <td className="num dim nowrap">{dateTime(r.created_at)}</td>
                <td className="nowrap">
                  {r.resolved_at ? (
                    <span className="dim">разобрано {dateTime(r.resolved_at)}</span>
                  ) : (
                    <button
                      className="small"
                      disabled={busy === r.application_id}
                      onClick={() => void resolve(r.application_id)}
                    >
                      разобрал
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/**
 * Failures with their screenshots and a requeue button.
 *
 * The breakdown by cause is the part that matters: twenty failures sharing one error
 * code are one broken selector, not twenty broken vacancies. Requeue is per-cause and
 * manual — automatic retries against hh are what turn a stale selector into a block.
 */
export function Failures({ version, onChange }: { version: number; onChange: () => void }) {
  const { data, error, reload } = useFetch(() => api.failed(), [version])
  const [busy, setBusy] = useState(false)

  const requeue = async (code?: string): Promise<void> => {
    setBusy(true)
    try {
      await api.requeue(code)
      reload()
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const requeueOne = async (id: number): Promise<void> => {
    setBusy(true)
    try {
      await api.requeueOne(id)
      reload()
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const markApplied = async (id: number): Promise<void> => {
    setBusy(true)
    try {
      await api.markApplied(id)
      reload()
      onChange()
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorLine error={error} />
  if (!data) return <Empty>загрузка…</Empty>
  if (data.rows.length === 0) return <Empty>неуспешных откликов нет</Empty>

  return (
    <>
      <p className="dim">
        Автоповторов нет: обычная причина — сломавшийся селектор, а повторы по кругу превращают его
        в блокировку аккаунта. Возвращайте в очередь, когда причина починена.
      </p>
      <div className="section">
        <h2>по причинам</h2>
        {data.breakdown.map((b) => (
          <div key={b.error_code} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span className="mono" style={{ minWidth: 220 }}>
              {b.error_code}
            </span>
            <span className="dim">{b.n}</span>
            <button className="small" disabled={busy} onClick={() => void requeue(b.error_code)}>
              вернуть в очередь
            </button>
          </div>
        ))}
        <button className="small danger" disabled={busy} onClick={() => void requeue()} style={{ marginTop: 6 }}>
          вернуть все
        </button>
      </div>

      <div className="section">
        <h2>последние</h2>
        <table>
          <thead>
            <tr>
              <th>вакансия</th>
              <th>код</th>
              <th>сообщение</th>
              <th>скриншот</th>
              <th className="num">когда</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.application_id}>
                <td>
                  <VacancyLink url={r.url} title={r.title} />
                  <div className="dim">{r.company ?? '—'}</div>
                </td>
                <td className="mono">{r.error_code ?? 'unknown'}</td>
                <td className="dim">{r.error_message ?? '—'}</td>
                <td>
                  <Shot path={r.screenshot_path} />
                </td>
                <td className="num dim nowrap">{dateTime(r.created_at)}</td>
                <td className="nowrap">
                  <button
                    className="small"
                    disabled={busy}
                    onClick={() => void requeueOne(r.application_id)}
                  >
                    вернуть в очередь
                  </button>{' '}
                  <button
                    className="small"
                    disabled={busy}
                    onClick={() => void markApplied(r.application_id)}
                  >
                    отметить как разобранное
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const STATUSES = ['all', 'applied', 'needs_human', 'failed', 'dry_run', 'skipped'] as const

export function History({ version }: { version: number }) {
  const [status, setStatus] = useState<string>('all')
  const { data, error } = useFetch(() => api.history(status), [version, status])

  return (
    <>
      <p className="dim">
        Всё, что бот сделал, вместе со скриншотом подтверждения. Успех отклика подтверждается по
        странице, а не предполагается, — скриншот и есть это подтверждение. В колонке «письмо» —
        текст, который ушёл вместе с этим откликом, в «ответах» — что бот вписал в форму
        вопросов работодателя (у пробных прогонов тоже).{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginLeft: 8 }}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'все статусы' : s}
            </option>
          ))}
        </select>
      </p>
      <ErrorLine error={error} />
      {!data ? (
        <Empty>загрузка…</Empty>
      ) : data.rows.length === 0 ? (
        <Empty>ничего не отправлялось</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>вакансия</th>
              <th>статус</th>
              <th>подробности</th>
              <th>письмо</th>
              <th>ответы</th>
              <th>скриншот</th>
              <th className="num">когда</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.application_id}>
                <td>
                  <VacancyLink url={r.url} title={r.title} />
                  <div className="dim">{r.company ?? '—'}</div>
                </td>
                <td className={`status ${r.status}`}>{r.status}</td>
                <td className="dim">
                  {r.error_code ?? r.needs_human_reason ?? '—'}
                  {r.error_message && <div className="mono">{r.error_message}</div>}
                </td>
                <td>
                  <LetterCell row={r} />
                </td>
                <td>
                  <AnswersCell row={r} />
                </td>
                <td>
                  <Shot path={r.screenshot_path} />
                </td>
                <td className="num dim nowrap">{dateTime(r.applied_at ?? r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/**
 * The config file itself, as it is written on disk.
 *
 * Not the parsed object: parsing fills in every zod default, so what came back looked
 * nothing like the file being edited. The path above it copies on click — the next
 * step after looking at the config is opening it in an editor.
 */
export function ConfigView({ state }: { state: DashboardState }) {
  const { data, error } = useFetch(() => api.config(), [])
  return (
    <>
      <ErrorLine error={error} />
      <div style={{ marginBottom: 10 }}>
        <CopyPath path={data?.path ?? state.configPath} />
      </div>
      {data && (data.raw !== null ? <pre className="json">{data.raw}</pre> : <Empty>Файла конфига нет.</Empty>)}
    </>
  )
}

/**
 * The letter queued for a vacancy: read it, fix it, approve it — before it is sent.
 *
 * Editing and approving are one action rather than two buttons. Someone who opened a
 * letter and changed a word wants that word sent; a separate "save" that has to be
 * pressed first is the step where the edit gets lost.
 */
function QueueLetter({
  row,
  needsApproval,
  onDone,
}: {
  row: PendingRow
  needsApproval: boolean
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(row.letter_text ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!row.letter_id || !row.letter_text) return <span className="dim">—</span>

  const approved = row.letter_approved_at !== null
  const edited = text.trim() !== row.letter_text.trim()

  const approve = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.approveLetter(row.letter_id!, edited ? text.trim() : undefined)
      setOpen(false)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="small" onClick={() => setOpen(true)}>
        открыть
      </button>
      {needsApproval && !approved && <span className="badge warn" style={{ marginLeft: 6 }}>не одобрено</span>}
      {approved && <span className="badge ok" style={{ marginLeft: 6 }}>одобрено</span>}
      {open && (
        <Modal
          title={row.title}
          subtitle={`${row.company ?? 'без компании'} · ${text.length} символов`}
          onClose={() => setOpen(false)}
        >
          <textarea
            className="letter-edit"
            value={text}
            rows={12}
            onChange={(e) => setText(e.target.value)}
          />
          <ErrorLine error={error} />
          <div className="letter-actions">
            <button className="primary" disabled={busy || text.trim().length === 0} onClick={() => void approve()}>
              {edited ? 'сохранить и одобрить' : 'одобрить'}
            </button>
            <button disabled={busy} onClick={() => setOpen(false)}>
              закрыть
            </button>
            {edited && <span className="dim">текст изменён</span>}
          </div>
        </Modal>
      )}
    </>
  )
}

/**
 * The letter this application actually carried.
 *
 * Empty for everything sent in static mode: that text lives in the config and is
 * never copied into the row, so there is nothing to show and saying so beats an
 * "открыть" button that opens an empty box.
 */
function LetterCell({ row }: { row: HistoryRow }) {
  const [open, setOpen] = useState(false)
  if (!row.letter_text) return <span className="dim">—</span>

  return (
    <>
      <button type="button" className="small" onClick={() => setOpen(true)}>
        открыть
      </button>
      {open && (
        <Modal
          title={row.title}
          subtitle={`${row.company ?? 'без компании'} · ${row.letter_text.length} символов`}
          onClose={() => setOpen(false)}
        >
          <p className="letter-view">{row.letter_text}</p>
        </Modal>
      )}
    </>
  )
}

/**
 * What went into the employer's question form. A dry run's answers are shown too —
 * the form was never sent, so this is the only place to judge them.
 */
function AnswersCell({ row }: { row: HistoryRow }) {
  const [open, setOpen] = useState(false)
  if (!row.answers_json) return <span className="dim">—</span>
  let answers: Array<{ question: string; answer: string }> = []
  try {
    answers = JSON.parse(row.answers_json)
  } catch {
    return <span className="dim">—</span>
  }

  return (
    <>
      <button type="button" className="small" onClick={() => setOpen(true)}>
        открыть ({answers.length})
      </button>
      {open && (
        <Modal
          title={row.title}
          subtitle={`${row.company ?? 'без компании'} · ${answers.length} вопросов`}
          onClose={() => setOpen(false)}
        >
          {answers.map((a, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div className="dim">
                {i + 1}. {a.question}
              </div>
              <p className="letter-view">{a.answer}</p>
            </div>
          ))}
        </Modal>
      )}
    </>
  )
}

const CHAT_STATUS: Record<ChatReplyRow['status'], [string, string]> = {
  sent: ['отвечено', 'ok-text'],
  needs_human: ['не смог ответить', 'warn-text'],
  human: ['пишет рекрутер', 'warn-text'],
  failed: ['не отправилось', 'danger-text'],
}

/**
 * Chat run output: every reply sent to hh's AI assistant, plus the chats it left to
 * the owner. Those were opened by the bot and are already read on hh — this tab is
 * the only place they still look new.
 */
export function Chats({ version, onChange }: { version: number; onChange: () => void }) {
  const [includeResolved, setIncludeResolved] = useState(false)
  const { data, error, reload } = useFetch(() => api.chats(includeResolved), [version, includeResolved])
  const [busy, setBusy] = useState<number | null>(null)

  const resolve = async (id: number): Promise<void> => {
    setBusy(id)
    try {
      await api.resolveChat(id)
      reload()
      onChange()
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrorLine error={error} />
  if (!data) return <Empty>загрузка…</Empty>

  return (
    <>
      <p className="dim">
        Ответы ИИ-помощнику hh и чаты, оставленные вам: живой рекрутер или вопрос, на который бот
        не смог ответить. Бот их уже открыл, на hh они прочитанные.{' '}
        <label style={{ marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
          />{' '}
          показывать разобранные
        </label>
      </p>
      {data.rows.length === 0 ? (
        <Empty>чатов ещё не было — «разобрать чаты» в шапке</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>вакансия</th>
              <th>вопрос</th>
              <th>ответ</th>
              <th>статус</th>
              <th className="num">когда</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const [label, cls] = CHAT_STATUS[r.status]
              return (
                <tr key={r.id}>
                  <td>
                    <a href={`https://hh.ru/chat/${r.chat_id}`} target="_blank" rel="noreferrer">
                      {r.title ?? `чат ${r.chat_id}`}
                    </a>
                    {r.company && <div className="dim">{r.company}</div>}
                  </td>
                  <td className="pre-wrap">{r.question}</td>
                  <td className="pre-wrap">{r.answer ?? <span className="dim">—</span>}</td>
                  <td>
                    <span className={cls}>{label}</span>
                    {r.reason && <div className="dim mono">{r.reason}</div>}
                    {r.screenshot_path && <Shot path={r.screenshot_path} />}
                  </td>
                  <td className="num dim nowrap">{dateTime(r.created_at)}</td>
                  <td className="nowrap">
                    {r.status === 'sent' ? null : r.resolved_at ? (
                      <span className="dim">разобрано {dateTime(r.resolved_at)}</span>
                    ) : (
                      <button className="small" disabled={busy === r.id} onClick={() => void resolve(r.id)}>
                        разобрал
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}

function Shot({ path }: { path: string | null }) {
  const [open, setOpen] = useState(false)
  if (!path) return <span className="dim">—</span>

  const url = screenshotUrl(path)
  return (
    <>
      <img
        className="shot"
        src={url}
        alt="скриншот"
        loading="lazy"
        title="открыть скриншот"
        onClick={() => setOpen(true)}
      />
      {open && <Lightbox src={url} alt="скриншот отклика" onClose={() => setOpen(false)} />}
    </>
  )
}

function salary(from: number | null, to: number | null, currency: string | null): string {
  if (from === null && to === null) return '—'
  const cur = currency ?? ''
  if (from !== null && to !== null) return `${fmt(from)}–${fmt(to)} ${cur}`
  if (from !== null) return `от ${fmt(from)} ${cur}`
  return `до ${fmt(to as number)} ${cur}`
}

const fmt = (n: number): string => n.toLocaleString('ru-RU')
