import { loadConfig } from '../config/load.js'
import { logger } from '../core/logger.js'
import { pingState } from './events.js'

const log = logger('ui')

export type RunMode = 'collect' | 'apply' | 'letters' | 'session'

export interface RunState {
  mode: RunMode
  startedAt: string
  /** Set for apply/letters: how many were asked for. */
  limit?: number
}

export interface RunOutcome {
  mode: RunMode
  startedAt: string
  finishedAt: string
  ok: boolean
  /** Pipeline result object, or the error message when ok is false. */
  result: unknown
}

/**
 * One run at a time, process-wide.
 *
 * Not a nicety: every pipeline drives the same persistent Chromium profile, and two
 * runs sharing it means two tabs racing the same hh session — exactly the traffic
 * shape that looks automated. The lock is also what makes the live log readable:
 * one run, one stream.
 */
let current: RunState | null = null
let last: RunOutcome | null = null

export const currentRun = (): RunState | null => current
export const lastRun = (): RunOutcome | null => last

export class BusyError extends Error {
  constructor(public readonly running: RunState) {
    super(`${running.mode} is already running since ${running.startedAt}`)
    this.name = 'BusyError'
  }
}

/**
 * Start a run and return immediately — the browser work takes minutes, and an HTTP
 * request that waits that long is a request that times out. Progress reaches the UI
 * over SSE; the outcome lands in `lastRun`.
 */
export function startRun(mode: RunMode, limit?: number): RunState {
  if (current) throw new BusyError(current)

  const state: RunState = { mode, startedAt: new Date().toISOString(), limit }
  current = state
  pingState(`run:${mode}:start`)
  log.info(`${mode} started${limit !== undefined ? ` (limit ${limit})` : ''}`)

  void execute(mode, limit)
    .then((result) => finish(state, true, result))
    .catch((e: unknown) => {
      log.error(`${mode} failed: ${(e as Error).message}`)
      finish(state, false, (e as Error).message)
    })

  return state
}

function finish(state: RunState, ok: boolean, result: unknown): void {
  last = { mode: state.mode, startedAt: state.startedAt, finishedAt: new Date().toISOString(), ok, result }
  current = null
  if (ok) log.info(`${state.mode} finished`, result)
  pingState(`run:${state.mode}:end`)
}

/**
 * Config is re-read per run rather than cached at boot: the config file is the only
 * way to change settings, so a server that cached it would need a restart after
 * every edit.
 */
async function execute(mode: RunMode, limit?: number): Promise<unknown> {
  const cfg = loadConfig(true)

  switch (mode) {
    case 'collect': {
      const { collect } = await import('../pipeline/collect.js')
      return await collect(cfg)
    }
    case 'apply': {
      const { runApplications } = await import('../pipeline/apply.js')
      return await runApplications(cfg, limit)
    }
    case 'letters': {
      const { writeLetters } = await import('../pipeline/letters.js')
      return await writeLetters(cfg, limit ?? cfg.letter.batchSize)
    }
    case 'session': {
      const { health } = await import('../hh/auth.js')
      return await health(cfg)
    }
  }
}
