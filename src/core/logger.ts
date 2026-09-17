import { EventEmitter } from 'node:events'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEvent {
  ts: string
  level: LogLevel
  scope: string
  msg: string
  data?: unknown
}

/** Single bus: console for the CLI, SSE for the UI (§7.2 events.ts). */
export const logBus = new EventEmitter<{ log: [LogEvent] }>()

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}

function emit(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  const ev: LogEvent = { ts: new Date().toISOString(), level, scope, msg, data }
  logBus.emit('log', ev)
  const time = ev.ts.slice(11, 19)
  const line = `${COLOR[level]}${time} ${level.padEnd(5)} [${scope}]\x1b[0m ${msg}`
  if (level === 'error') console.error(line, data ?? '')
  else console.log(line, data ?? '')
}

export function logger(scope: string) {
  return {
    debug: (msg: string, data?: unknown) => emit('debug', scope, msg, data),
    info: (msg: string, data?: unknown) => emit('info', scope, msg, data),
    warn: (msg: string, data?: unknown) => emit('warn', scope, msg, data),
    error: (msg: string, data?: unknown) => emit('error', scope, msg, data),
  }
}
