import { useState } from 'react'
import { api, screenshotUrl, type DashboardState, type HistoryRow, type PendingRow } from './api'
import { CopyPath, Empty, ErrorLine, Lightbox, Modal, VacancyLink, dateTime, useFetch } from './common'

/** Pending queue, in the exact order the next run will walk it. */
export function Pending({ version, state }: { version: number; state: DashboardState }) {
  const { data, error, reload } = useFetch(() => api.pending(200), [version])
  if (error) return <ErrorLine error={error} />
  if (!data) return <Empty>загрузка…</Empty>
  if (data.rows.length === 0) return <Empty>очередь пуста — соберите вакансии</Empty>

  const llm = state.letter.mode === 'llm'

  return (
    <>
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
}

/**
 * The manual queue. These were refused on purpose — a generated answer to an
 * employer's question is worse than no answer, because it is exactly where the
 * employer is checking for a human.
 */
export function NeedsHuman({ version, onChange }: { version: number; onChange: () => void }) {
  const [includeResolved, setIncludeResolved] = useState(false)
  const { data, error, reload } = useFetch(() => api.needsHuman(includeResolved), [version, includeResolved])
  const [busy, setBusy] = useState<number | null>(null)

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

  if (error) return <ErrorLine error={error} />
  if (!data) return <Empty>загрузка…</Empty>

  return (
    <>
      <p className="dim">
        Эти вакансии бот не откликает намеренно: вопросы работодателя и тестовые пишет человек.
        Лимит на них не тратится.{' '}
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
                <td>{REASONS[r.needs_human_reason ?? ''] ?? r.needs_human_reason ?? '—'}</td>
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
    const what = code ? `все неуспешные с кодом ${code}` : 'все неуспешные отклики'
    if (!confirm(`Вернуть ${what} в очередь? Делайте это после того, как причина починена.`)) return
    setBusy(true)
    try {
      await api.requeue(code)
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
        текст, который ушёл вместе с этим откликом.{' '}
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
