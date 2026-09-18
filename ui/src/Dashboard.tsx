import { useEffect, useState } from 'react';
import { api, type DashboardState } from './api';
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
        {/* Неуспешные красные всегда, даже на нуле: это единственная очередь, которую
            никто не разгребает сам — её видно, только если она заметна. */}
        <Card label='неуспешные' value={counts.failed} sub='лимит не тратят' tone='danger' />
        <Card
          label='откликов всего'
          value={counts.appliedTotal}
          sub={`пробных прогонов ${counts.byStatus.dry_run ?? 0}`}
        />
        {state.letter.mode === 'llm' && (
          // Without manual approval nothing is actually waiting: these letters are
          // written and will be sent as they are. Calling that "на одобрении" sent the
          // owner looking for an approval screen that had no reason to exist.
          <Card
            label={state.letter.requireManualApproval ? 'писем на одобрении' : 'писем готово'}
            value={counts.lettersAwaitingApproval}
            sub={state.letter.requireManualApproval ? 'вкладка «очередь»' : 'уйдут с ближайшим откликом'}
          />
        )}
      </div>

      <div className='section'>
        <h2>настройки прогона</h2>
        <table>
          <tbody>
            <Row k='поиск'>
              <SearchText text={state.search.text} busy={!!state.run} onSaved={onChange} />
            </Row>
            <Row k='письмо'>
              <Letter letter={state.letter} busy={!!state.run} onSaved={onChange} />
            </Row>
          </tbody>
        </table>
      </div>

      {state.lastRun && (
        <div className='section'>
          <h2>последний прогон</h2>
          <div className={`notice ${state.lastRun.ok ? 'info' : 'danger'}`}>
            <b>{state.lastRun.mode}</b> · {dateTime(state.lastRun.startedAt)} → {dateTime(state.lastRun.finishedAt)}
            <pre className='json' style={{ marginTop: 8 }}>
              {JSON.stringify(state.lastRun.result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The hh search query, the one search setting editable here.
 *
 * It is what decides how many vacancies exist to apply to at all, and the goal is
 * coverage — widening the query is the cheapest way to get more of it. The rest of
 * the search block stays a file edit.
 *
 * The field is only reset from the server while it is untouched: overwriting a draft
 * because a live-state poll arrived mid-typing is how an edit disappears.
 */
function SearchText({ text, busy, onSaved }: { text: string; busy: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = value.trim() !== text.trim();

  useEffect(() => {
    setValue((v) => (v.trim() === text.trim() ? text : v));
  }, [text]);

  const save = async (): Promise<void> => {
    if (!dirty || !value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.setSearchText(value);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className='search-text'>
        <input
          type='text'
          value={value}
          spellCheck={false}
          placeholder='frontend OR фронтенд OR react OR vue'
          disabled={busy || saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setValue(text);
          }}
        />
        <button
          className={dirty ? 'primary' : ''}
          disabled={!dirty || !value.trim() || busy || saving}
          title={busy ? 'идёт прогон — поиск не меняется на ходу' : 'записать в config.json'}
          onClick={() => void save()}>
          сохранить
        </button>
        {dirty && !busy && <span className='dim'>не сохранено</span>}
      </div>
      {error && <div className='dim danger-text'>{error}</div>}
    </>
  );
}

/**
 * Режим письма и, для статического, сам текст.
 *
 * Переключатель здесь, потому что это решение про один отклик, а не про конфиг:
 * статический текст уходит как есть и ни от чего не зависит, режим llm требует
 * `npm run letters` заранее — без сгенерированного письма отклик просто не уйдёт,
 * поэтому выбор llm об этом и предупреждает прямо в строке.
 *
 * Текст, как и строка поиска, не затирается живым обновлением состояния, пока
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
          письма в начале прогона — отдельная кнопка «письма» нужна, только если хочется сделать это заранее и
          прочитать. Вакансия, для которой письмо написать не вышло, пропускается и остаётся в очереди.
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
