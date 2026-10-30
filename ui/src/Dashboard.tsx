import { Fragment, useEffect, useState } from 'react';
import {
  api,
  type ApplyResult,
  type ChatRunResult,
  type CollectResult,
  type DashboardState,
  type HealthReport,
  type RunMode,
  type SelfCheckReport,
  screenshotUrl,
} from './api';
import { dateTime } from './common';

export function Dashboard({ state, onChange }: { state: DashboardState; onChange: () => void }) {
  const { counts, limits } = state;

  return (
    <>
      {!state.session.hasProfile && (
        <div className='notice danger'>
          Сессии hh нет. Войти можно только руками: <code className='mono'>npm run login</code>. Пароль нигде не
          хранится, поэтому кнопки входа здесь нет и не будет.
        </div>
      )}
      <Alarms state={state} onChange={onChange} />
      <div className='cards'>
        <Card label='в очереди' value={counts.pending} sub={`${counts.vacancies} вакансий собрано всего`} />
        {/* Отправлено и лимит — одна цифра, а не две карточки: вопрос всегда «сколько
            осталось», и он читается только из отношения. Красная, когда не осталось. */}
        <Card
          label='лимит за 24ч'
          value={`${counts.appliedDay}/${limits.perDay}`}
          sub={`пробных прогонов ${counts.byStatus.dry_run ?? 0}`}
          tone={counts.appliedDay >= limits.perDay ? 'danger' : undefined}
        />
        <Card
          label='ручная очередь'
          value={counts.needsHuman}
          sub='вопросы, тестовые, внешние формы'
          tone={counts.needsHuman > 0 ? 'warn' : undefined}
        />
        {/* Красная, только когда есть что разбирать: на нуле красный цвет сигналит
            о проблеме, которой нет. */}
        <Card
          label='неуспешные'
          value={counts.failed}
          sub='лимит не тратят'
          tone={counts.failed > 0 ? 'danger' : undefined}
        />
        <Card
          label='откликов всего'
          value={counts.appliedTotal}
          sub={`пробных прогонов ${counts.byStatus.dry_run ?? 0}`}
        />
        <SelectorCard health={state.selectorHealth} />
      </div>

      <div className='section'>
        <h2>настройки прогона</h2>
        <table>
          <tbody>
            <Row k='письмо'>
              <Letter letter={state.letter} busy={!!state.run} onSaved={onChange} />
            </Row>
          </tbody>
        </table>
      </div>

      {state.lastRun && <LastRun run={state.lastRun} />}
    </>
  );
}

/**
 * Режим письма и, для статического, сам текст.
 *
 * Переключатель здесь, потому что это решение про один отклик, а не про конфиг:
 * статический текст уходит как есть и ни от чего не зависит, в режиме llm письма
 * пишет сам прогон откликов, а вакансия без письма пропускается и остаётся в очереди.
 *
 * Текст не затирается живым обновлением состояния, пока
 * в поле лежит несохранённый черновик.
 */
function Letter({ letter, busy, onSaved }: { letter: DashboardState['letter']; busy: boolean; onSaved: () => void }) {
  const [text, setText] = useState(letter.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = text.trim() !== letter.text.trim();

  useEffect(() => {
    setText((t) => (t.trim() === letter.text.trim() ? letter.text : t));
  }, [letter.text]);

  const save = async (patch: { mode?: 'static' | 'llm'; text?: string }): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.setLetter(patch);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className='modes'>
        {(['static', 'llm'] as const).map((m) => (
          <button
            key={m}
            className={letter.mode === m ? 'active' : ''}
            disabled={busy || saving || letter.mode === m}
            title={busy ? 'идёт прогон — режим письма не меняется на ходу' : 'записать в config.json'}
            onClick={() => void save({ mode: m })}>
            {m === 'static' ? 'статическое' : 'генерировать ИИ'}
          </button>
        ))}
      </div>

      {letter.mode === 'static' ? (
        <div className='letter-text'>
          <textarea
            value={text}
            rows={4}
            spellCheck={false}
            disabled={busy || saving}
            placeholder='текст, который уйдёт с каждым откликом'
            onChange={(e) => setText(e.target.value)}
          />
          <div className='letter-actions'>
            <button
              className={dirty ? 'primary' : ''}
              disabled={!dirty || !text.trim() || busy || saving}
              onClick={() => void save({ text })}>
              сохранить
            </button>
            <span className='dim'>
              {text.trim().length} знаков{dirty ? ' · не сохранено' : ''}
            </span>
          </div>
        </div>
      ) : (
        <div className='dim'>
          письмо под каждую вакансию, до {letter.maxChars} знаков
          {letter.requireManualApproval ? ' · с ручным одобрением' : ' · без одобрения'}. Отклик сам пишет недостающие
          письма в начале прогона. Вакансия, для которой письмо написать не вышло, пропускается и остаётся в очереди.
        </div>
      )}
      {error && <div className='danger-text'>{error}</div>}
    </>
  );
}

/**
 * Open selector alarms, above everything else. The one banner on the dashboard on
 * purpose: on 27-29.10 the chat markup moved and every run reported zeros for days —
 * a signal that can be missed is how that happened.
 */
function Alarms({ state, onChange }: { state: DashboardState; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const { alarms } = state.selectorHealth;
  if (alarms.length === 0) return null;

  const act = async (f: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await f();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className='notice danger'>
      <b>похоже, hh сменил вёрстку — прогоны могут молча ничего не делать</b>
      <ul className='alarms'>
        {alarms.map((a) => (
          <li key={a.id}>
            <span className='dim'>{dateTime(a.created_at)} · </span>
            {a.message}
          </li>
        ))}
      </ul>
      <div className='letter-actions'>
        <button className='primary' disabled={!!state.run} onClick={() => void act(() => api.run('selfcheck'))}>
          проверить селекторы
        </button>
        <button disabled={!!state.run} onClick={() => void act(() => api.resolveAlarms())} title='это не вёрстка — закрыть тревоги'>
          разобрал
        </button>
        <span className='dim'>зелёная проверка закрывает тревоги сама</span>
      </div>
      {error && <div className='danger-text'>{error}</div>}
    </div>
  );
}

function SelectorCard({ health }: { health: DashboardState['selectorHealth'] }) {
  const { lastCheck, alarms } = health;
  const broken = (lastCheck && !lastCheck.ok) || alarms.length > 0;
  return (
    <Card
      label='селекторы'
      value={!lastCheck ? '—' : lastCheck.ok ? 'ок' : `сломано ${lastCheck.broken}`}
      sub={
        (lastCheck ? `проверено ${dateTime(lastCheck.at)}` : 'ещё не проверялись') +
        (alarms.length ? ` · тревог ${alarms.length}` : '')
      }
      // Green on «ок», red on a broken check or an open alarm; grey only before the first check.
      tone={broken ? 'danger' : lastCheck ? 'ok' : undefined}
    />
  );
}

function Card({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    // Тон несёт карточка целиком — фон и граница, а не цвет цифры.
    <div className={`card ${tone ?? ''}`}>
      <div className='label'>{label}</div>
      <div className='value'>{value}</div>
      {sub && <div className='sub'>{sub}</div>}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className='dim nowrap' style={{ width: 130 }}>
        {k}
      </td>
      <td>{children}</td>
    </tr>
  );
}

const RUN_TITLES: Record<RunMode, string> = {
  collect: 'сбор вакансий',
  apply: 'отклики',
  session: 'проверка сессии',
  chats: 'разбор чатов',
  selfcheck: 'проверка селекторов',
};

function duration(fromIso: string, toIso: string): string {
  const total = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m} мин ${sec} с` : `${sec} с`;
}

/** Optional third element tints the value — only for counts worth noticing. */
// `always` keeps the tone on zero too and colours the label with it; otherwise a
// zero is greyed out and only the number carries the tone.
type Stat = [label: string, value: React.ReactNode, tone?: 'ok' | 'warn' | 'danger', always?: boolean];

// Mirrors DROP_LABEL in src/scoring/filters.ts — the UI does not import server code.
const DROP_LABEL: Record<string, string> = {
  already_applied: 'уже откликались',
  has_test: 'тестовое задание',
  company_blacklist: 'компания в чёрном списке',
  title_blacklist: 'стоп-слово в названии',
  not_frontend: 'не фронтенд',
};

/** Counts collapse to «ключ: n» pairs; an empty map says nothing, so it is left out. */
function breakdown(label: string, map: Record<string, number> | undefined): Stat[] {
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) return [];
  return [[label, entries.map(([k, n]) => `${k}: ${n}`).join(' · ')]];
}

/**
 * The run's result as label/value rows. Returns null for a shape it doesn't know —
 * the caller then falls back to JSON rather than showing a half-empty list.
 */
function runStats(mode: RunMode, result: unknown): Stat[] | null {
  if (typeof result !== 'object' || result === null) return null;
  switch (mode) {
    case 'collect': {
      const r = result as CollectResult;
      if (typeof r.queued !== 'number') return null;
      return [
        ['собрано с выдачи', r.scraped],
        ['попало в очередь', r.queued, 'ok', true],
        ['было разобрано', r.handled],
        // One row per drop reason: "уже откликались: 196" reads on its own, a
        // generic "отсеяно" heading over raw reason codes did not.
        ...Object.entries(r.dropped ?? {}).map(([k, n]): Stat => [DROP_LABEL[k] ?? k, n]),
        ...breakdown('по резюме', r.byResume),
        ...alarmStats(r.alarms),
      ];
    }
    case 'apply': {
      const r = result as ApplyResult;
      if (typeof r.planned !== 'number') return null;
      return [
        ['запланировано', r.planned],
        ['отправлено', r.applied, 'ok'],
        ['пробных', r.dryRun],
        ['ручные', r.needsHuman, 'warn'],
        ['пропущено', r.skipped],
        ['неуспешно', r.failed, 'danger'],
        ...(r.stopReason ? ([['остановлен', STOP_LABEL[r.stopReason] ?? r.stopReason]] as Stat[]) : []),
        ...alarmStats(r.alarms),
      ];
    }
    case 'chats': {
      const r = result as ChatRunResult;
      if (typeof r.passes !== 'number') return null;
      return [
        ['проходов', r.passes],
        ['чатов', r.chats],
        ['отвечено', r.answered, 'ok'],
        ['оставлено вам', r.needsHuman + r.human, 'warn'],
        ['рассылки и отказы', r.mailings ?? 0],
        ['помощник закончил', r.finished],
        ['не отправилось', r.failed, 'danger'],
        ...(r.unreadable ? ([['лента не прочиталась', r.unreadable, 'danger']] as Stat[]) : []),
        ...(r.stopReason ? ([['остановлен', r.stopReason]] as Stat[]) : []),
        ...alarmStats(r.alarms),
      ];
    }
    case 'selfcheck':
      // Rendered as a list of checks by SelfCheckView, not as label/value rows.
      return null;
    case 'session': {
      const r = result as HealthReport;
      if (typeof r.loggedIn !== 'boolean') return null;
      return [
        ['вход', r.loggedIn ? 'да' : 'нет'],
        ['состояние', r.state],
        [
          'страница',
          <a href={r.url} target='_blank' rel='noreferrer'>
            {r.url}
          </a>,
        ],
      ];
    }
  }
}

const STOP_LABEL: Record<string, string> = {
  selectors_suspect: 'похоже на сломанные селекторы',
};

function alarmStats(alarms: string[] | undefined): Stat[] {
  return (alarms ?? []).map((a, i): Stat => [i === 0 ? 'тревога' : '', a, 'danger', true]);
}

/** One line per check; a broken one says what, which selector keys, and where the dump is. */
function SelfCheckView({ report }: { report: SelfCheckReport }) {
  return (
    <ul className='selfcheck'>
      {report.checks.map((c, i) => (
        <li key={i} className={c.status}>
          <span className='mark'>{c.status === 'ok' ? '✓' : c.status === 'broken' ? '✗' : '–'}</span>
          <b>{c.name}</b>: {c.detail}
          {c.missingKeys?.length ? (
            <div className='mono'>не найдено: {c.missingKeys.join(', ')}</div>
          ) : null}
          {c.screenshot && (
            <div>
              <a href={screenshotUrl(c.screenshot)} target='_blank' rel='noreferrer'>
                скриншот
              </a>
              {c.dump && <span className='dim mono'> · html: {c.dump}</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Last run as readable text; the raw result stays one click away for debugging. */
function LastRun({ run }: { run: NonNullable<DashboardState['lastRun']> }) {
  const [showJson, setShowJson] = useState(false);
  const report =
    run.ok && run.mode === 'selfcheck' && Array.isArray((run.result as SelfCheckReport | null)?.checks)
      ? (run.result as SelfCheckReport)
      : null;
  const stats = run.ok && !report ? runStats(run.mode, run.result) : null;

  return (
    <div className='section'>
      <h2>последний прогон</h2>
      <div className={`notice ${run.ok ? 'info' : 'danger'}`}>
        <b>{RUN_TITLES[run.mode] ?? run.mode}</b> · {dateTime(run.startedAt)} → {dateTime(run.finishedAt)}
        <span className='dim'> · {duration(run.startedAt, run.finishedAt)}</span>
        {!run.ok && <div className='danger-text'>упал: {String(run.result)}</div>}
        {stats && (
          <dl className='run-stats'>
            {stats.map(([label, value, tone, always], i) => (
              <Fragment key={`${label}-${i}`}>
                <dt className={always ? tone : undefined}>{label}</dt>
                <dd className={value === 0 && !always ? 'zero' : tone}>{value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {report && <SelfCheckView report={report} />}
        {run.ok && !stats && !report && (
          <div className='dim' style={{ marginTop: 6 }}>итог в незнакомом виде — см. JSON</div>
        )}
        <div className='run-json'>
          <button className='small' onClick={() => setShowJson((v) => !v)}>
            {showJson ? 'скрыть JSON' : 'показать JSON'}
          </button>
          {showJson && (
            <pre className='json' style={{ marginTop: 8 }}>
              {JSON.stringify(run.result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
