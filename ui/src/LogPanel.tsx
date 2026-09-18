import { useEffect, useRef } from 'react'
import type { LogEvent } from './api'
import { shortTime } from './common'

/**
 * The live log, straight off the server's event bus.
 *
 * Auto-scroll is suspended the moment the user scrolls up: a run that is failing is
 * exactly when someone is reading a line further back, and yanking them to the
 * bottom every 200ms makes that impossible.
 */
export function LogPanel({ logs, connected }: { logs: LogEvent[]; connected: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const box = boxRef.current
    if (box && stickRef.current) box.scrollTop = box.scrollHeight
  }, [logs])

  const onScroll = (): void => {
    const box = boxRef.current
    if (!box) return
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }

  return (
    <aside className="log">
      <header>
        <span className={`dot ${connected ? 'on' : 'off'}`} />
        живой лог {connected ? '' : '— соединение потеряно'}
      </header>
      <div className="lines" ref={boxRef} onScroll={onScroll}>
        {logs.length === 0 && <span className="dim">пока тихо</span>}
        {logs.map((l, i) => (
          <div className={`line ${l.level}`} key={`${l.ts}-${i}`}>
            <span className="time">{shortTime(l.ts)}</span>
            <span className="scope" title={l.scope}>
              {l.scope}
            </span>
            <span className="msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
