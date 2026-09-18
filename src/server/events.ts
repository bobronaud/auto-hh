import { EventEmitter } from 'node:events'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { logBus, type LogEvent } from '../core/logger.js'

/**
 * The UI's own event bus, next to the log bus.
 *
 * Logs answer "what is happening", this answers "what changed" — a run started, a
 * queue shrank. The two are separate because the UI reacts to them differently: logs
 * append to a stream, a state ping triggers a refetch.
 */
export const uiBus = new EventEmitter<{ state: [{ reason: string }] }>()

export function pingState(reason: string): void {
  uiBus.emit('state', { reason })
}

/**
 * Last N log lines, kept so a browser opened mid-run is not blank.
 *
 * The bus is subscribed once at import time rather than per connection: a run started
 * before anyone opened the UI still ends up on screen.
 */
const BUFFER_SIZE = 500
const buffer: LogEvent[] = []

logBus.on('log', (ev) => {
  buffer.push(ev)
  if (buffer.length > BUFFER_SIZE) buffer.shift()
})

export function recentLogs(): LogEvent[] {
  return [...buffer]
}

/** Heartbeat interval. Not an hh interaction, so a fixed period is fine here. */
const HEARTBEAT_MS = 15_000

export function sseHandler(req: FastifyRequest, reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  for (const ev of recentLogs()) send('log', ev)
  send('state', { reason: 'connected' })

  const onLog = (ev: LogEvent): void => send('log', ev)
  const onState = (ev: { reason: string }): void => send('state', ev)
  logBus.on('log', onLog)
  uiBus.on('state', onState)

  const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS)

  req.raw.on('close', () => {
    clearInterval(heartbeat)
    logBus.off('log', onLog)
    uiBus.off('state', onState)
  })
}
