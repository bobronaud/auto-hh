import { useState } from 'react';
import { api, type RunMode } from './api';
import { useLive } from './live';
import { Dashboard } from './Dashboard';
import { LogPanel } from './LogPanel';
import { ConfigView, Failures, History, NeedsHuman, Pending } from './Queues';
import { ErrorLine, dateTime } from './common';
import logo from '../logo.png';

type Tab = 'dashboard' | 'pending' | 'needs_human' | 'failed' | 'history' | 'config';

export function App() {
  const { state, error, logs, connected, refresh } = useLive();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [applyCount, setApplyCount] = useState(100);
  // Days back for collect, 0 = all time. Per run, not saved to the config.
  const [collectPeriod, setCollectPeriod] = useState(3);
  const [runError, setRunError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  // Bumped whenever a queue may have changed, so the open tab refetches.
  const [version, setVersion] = useState(0);
  const bump = (): void => {
    setVersion((v) => v + 1);
    refresh();
  };

  const busy = state?.run ?? null;

  const toggleDryRun = async (): Promise<void> => {
    if (!state) return;
    const next = !state.dryRun;
    setRunError(null);
    setSwitching(true);
    try {
      await api.setDryRun(next);
      bump();
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  const run = async (mode: RunMode, opts?: { limit?: number; period?: number }): Promise<void> => {
    setRunError(null);
    try {
      await api.run(mode, opts);
      bump();
    } catch (e) {
      setRunError((e as Error).message);
    }
  };

  if (!state) {
    return (
      <div className='app'>
        <main style={{ padding: 40 }}>
          {error ? (
            <div className='notice danger'>
              Сервер не отвечает: {error}
              <div className='dim' style={{ marginTop: 6 }}>
                Запустите его: <span className='mono'>npm run dev</span>
              </div>
            </div>
          ) : (
            <span className='dim'>подключаемся…</span>
          )}
        </main>
      </div>
    );
  }

  const tabs: Array<[Tab, string, number | null]> = [
    ['dashboard', 'дашборд', null],
    ['pending', 'очередь', state.counts.pending],
    ['needs_human', 'ручные', state.counts.needsHuman],
    ['failed', 'неуспешные', state.counts.failed],
    ['history', 'история', state.counts.appliedTotal],
    ['config', 'конфиг', null],
  ];

  return (
    <div className='app'>
      <header>
        <div className='brand'>
          <img className='logo' src={logo} alt='' />
          AutoHH
        </div>
        <button
          className={`badge toggle ${state.dryRun ? 'dry' : 'live'}`}
          disabled={!!busy || switching}
          title={
            busy
              ? 'идёт прогон — режим не переключается на ходу'
              : state.dryRun
                ? 'включить боевой режим'
                : 'вернуться к пробе'
          }
          onClick={() => void toggleDryRun()}>
          {state.dryRun ? 'проба · ничего не отправляется' : 'боевой режим'}
        </button>
        {!state.session.hasProfile && <span className='badge warn'>нет сессии hh</span>}

        <div className='spacer' />

        <div className='runbar'>
          {busy ? (
            <span className='badge neutral'>
              идёт {busy.mode}
              {busy.limit ? ` ×${busy.limit}` : ''}
              {busy.period !== undefined ? ` · ${busy.period === 0 ? 'за всё время' : `за ${busy.period} дн.`}` : ''} · с {dateTime(busy.startedAt)}
            </span>
          ) : (
            <>
              <input
                type='number'
                min={1}
                max={500}
                value={applyCount}
                onChange={(e) => setApplyCount(Number(e.target.value))}
                title='сколько откликов за прогон'
              />
              <button
                className='primary'
                disabled={!state.limits.state.allowed || state.counts.pending === 0}
                title={
                  state.limits.state.allowed
                    ? 'откликнуться на n вакансий из очереди'
                    : 'лимит исчерпан — скользящее окно'
                }
                onClick={() => void run('apply', { limit: applyCount })}>
                откликнуться ×{applyCount}
              </button>
              <select
                value={collectPeriod}
                onChange={(e) => setCollectPeriod(Number(e.target.value))}
                title='за какой срок собирать вакансии'>
                <option value={3}>3 дня</option>
                <option value={7}>7 дней</option>
                <option value={0}>всё время</option>
              </select>
              <button onClick={() => void run('collect', { period: collectPeriod })}>собрать вакансии</button>
              <button onClick={() => void run('session')}>проверить сессию</button>
            </>
          )}
        </div>
      </header>

      <nav>
        {tabs.map(([id, label, count]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
            {count !== null && <span className='count'>{count}</span>}
          </button>
        ))}
      </nav>

      <div className='body'>
        <main>
          <ErrorLine error={runError} />
          {tab === 'dashboard' && <Dashboard state={state} onChange={bump} />}
          {tab === 'pending' && <Pending version={version} state={state} onChange={bump} />}
          {tab === 'needs_human' && <NeedsHuman version={version} onChange={bump} />}
          {tab === 'failed' && <Failures version={version} onChange={bump} />}
          {tab === 'history' && <History version={version} />}
          {tab === 'config' && <ConfigView state={state} />}
        </main>
        <LogPanel logs={logs} connected={connected} />
      </div>
    </div>
  );
}
