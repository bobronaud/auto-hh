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
/** Vite proxies with changeOrigin, so its requests arrive as 127.0.0.1:PORT too. */
const ALLOWED_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`]
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

async function main(): Promise<void> {
  getDb()

  const app = Fastify({ logger: false })
  await app.register(cors, { origin: UI_ORIGINS })

  /**
   * CORS alone does not protect this server: it only stops a foreign page from
   * reading the response, the request itself still runs. Any site open in the
   * owner's browser could fire a body-less `fetch(..., { method: 'POST', mode:
   * 'no-cors' })` at /api/run/apply and send real applications.
   *
   * - Host: a DNS-rebound domain resolves to 127.0.0.1 but keeps its own name in
   *   Host, and would otherwise become same-origin with this API and read it all.
   * - POSTs must be application/json, which a browser never sends cross-origin
   *   without a preflight, and the preflight is refused for foreign origins.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!ALLOWED_HOSTS.includes(req.headers.host ?? '')) {
      return reply.code(403).send({ error: 'forbidden host' })
    }
    if (SAFE_METHODS.includes(req.method)) return
    const origin = req.headers.origin
    if (origin !== undefined && !UI_ORIGINS.includes(origin)) {
      return reply.code(403).send({ error: 'forbidden origin' })
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).send({ error: 'application/json required' })
    }
  })
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
