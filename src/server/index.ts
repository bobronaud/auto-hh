import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerRoutes } from './routes.js'
import { getDb, closeDb } from '../db/index.js'
import { logger } from '../core/logger.js'

const log = logger('server')

/**
 * Local only, always.
 *
 * This server drives a logged-in hh session and can submit applications with one
 * POST — nothing about it is safe to expose beyond the machine it runs on, and
 * binding to 127.0.0.1 is what keeps "localhost tool" from quietly becoming "open
 * on the Wi-Fi".
 */
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT ?? 3000)
/** Vite dev server; the built UI is served same-origin and needs no entry here. */
const UI_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

async function main(): Promise<void> {
  getDb()

  const app = Fastify({ logger: false })
  await app.register(cors, { origin: UI_ORIGINS })
  await registerRoutes(app)

  await app.listen({ host: HOST, port: PORT })
  log.info(`http://${HOST}:${PORT} — UI on http://localhost:5173`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => {
        closeDb()
        process.exit(0)
      })
    })
  }
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).message}\n`)
  process.exitCode = 1
})
