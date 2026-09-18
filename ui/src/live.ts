import { useEffect, useRef, useState } from 'react'
import { api, type DashboardState, type LogEvent } from './api'

const LOG_LIMIT = 500

/**
 * One EventSource for the whole app: the log stream and the "something changed" ping
 * arrive on the same connection, so the dashboard refetches exactly when a run moves
 * rather than on a timer.
 */
export function useLive(): {
  state: DashboardState | null
  error: string | null
  logs: LogEvent[]
  connected: boolean
  refresh: () => void
} {
  const [state, setState] = useState<DashboardState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [tick, setTick] = useState(0)

  const refresh = (): void => setTick((t) => t + 1)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    let cancelled = false
    api
      .state()
      .then((s) => {
        if (cancelled) return
        setState(s)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    const es = new EventSource('/api/events')

    es.addEventListener('open', () => setConnected(true))
    es.addEventListener('error', () => setConnected(false))
    es.addEventListener('log', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as LogEvent
      setLogs((prev) => (prev.length >= LOG_LIMIT ? [...prev.slice(1), ev] : [...prev, ev]))
    })
    // A state ping means the database moved under us — refetch rather than guess.
    es.addEventListener('state', () => {
      setConnected(true)
      refreshRef.current()
    })

    return () => es.close()
  }, [])

  // While a run is in flight the counters change without a ping for every application;
  // a slow poll keeps them honest and stops the moment the run does.
  useEffect(() => {
    if (!state?.run) return
    const id = setInterval(() => refreshRef.current(), 4000)
    return () => clearInterval(id)
  }, [state?.run?.startedAt, state?.run?.mode])

  return { state, error, logs, connected, refresh }
}
