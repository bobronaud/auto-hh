import { Fragment, useEffect, useState } from 'react';
import {
  api,
  type ApplyResult,
  type CollectResult,
  type DashboardState,
  type HealthReport,
  type RunMode,
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
        ...(r.stopReason ? ([['остановлен', r.stopReason]] as Stat[]) : []),
      ];
    }
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

/** Last run as readable text; the raw result stays one click away for debugging. */
function LastRun({ run }: { run: NonNullable<DashboardState['lastRun']> }) {
  const [showJson, setShowJson] = useState(false);
  const stats = run.ok ? runStats(run.mode, run.result) : null;

  return (
    <div className='section'>
      <h2>последний прогон</h2>
      <div className={`notice ${run.ok ? 'info' : 'danger'}`}>
        <b>{RUN_TITLES[run.mode] ?? run.mode}</b> · {dateTime(run.startedAt)} → {dateTime(run.finishedAt)}
        <span className='dim'> · {duration(run.startedAt, run.finishedAt)}</span>
        {!run.ok && <div className='danger-text'>упал: {String(run.result)}</div>}
        {stats && (
          <dl className='run-stats'>
            {stats.map(([label, value, tone, always]) => (
              <Fragment key={label}>
                <dt className={always ? tone : undefined}>{label}</dt>
                <dd className={value === 0 && !always ? 'zero' : tone}>{value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {run.ok && !stats && <div className='dim' style={{ marginTop: 6 }}>итог в незнакомом виде — см. JSON</div>}
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
