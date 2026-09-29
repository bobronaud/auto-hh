import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Repo, type ApplicationStatus } from '../db/repo.js'
import { loadConfig, configSource } from '../config/load.js'
import { setDryRun, setLetter, setSearchText } from '../config/save.js'
import { limitWarnings } from '../config/schema.js'
import { CONFIG_EXAMPLE_PATH, CONFIG_PATH, SCREENSHOT_DIR, projectPath } from '../core/paths.js'
import { dashboardState } from './state.js'
import { sseHandler, pingState } from './events.js'
import { startRun, BusyError, currentRun, type RunMode } from './runner.js'

const RUN_MODES: RunMode[] = ['collect', 'apply', 'session']
/** Collect periods the UI offers; 0 is "all time". hh itself only knows 1/3/7/30. */
const COLLECT_PERIODS = [0, 3, 7]

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const repo = new Repo()

  app.get('/api/state', () => dashboardState())

  app.get('/api/events', (req, reply) => {
    sseHandler(req, reply)
  })

  // ------------------------------------------------------------------- queues

  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/queue/pending', (req) => {
    const limit = clamp(Number(req.query.limit ?? 100), 1, 500)
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0)
    return { total: repo.countPending(), limit, offset, rows: repo.pendingPage(limit, offset) }
  })

  /**
   * Remove one vacancy from the queue by hand. Refused during a run: the run took its
   * candidates at the start, so a vacancy dismissed halfway could still be applied to.
   */
  app.post<{ Params: { id: string } }>('/api/vacancies/:id/dismiss', (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad vacancy id' })

    const running = currentRun()
    if (running) {
      return reply.code(409).send({ error: `${running.mode} is running — wait for it to finish`, running })
    }
    if (!repo.dismissVacancy(id)) return reply.code(409).send({ error: 'vacancy is not in the queue' })
    pingState('vacancy:dismissed')
    return { ok: true, id }
  })

  app.get<{ Querystring: { includeResolved?: string } }>('/api/queue/needs-human', (req) => ({
    rows: repo.needsHuman({ includeResolved: req.query.includeResolved === 'true' }),
  }))

  app.get('/api/queue/failed', () => ({
    rows: repo.failedApplications(),
    breakdown: repo.failureBreakdown(),
  }))

  app.get<{ Querystring: { limit?: string; status?: string } }>('/api/history', (req) => {
    const limit = clamp(Number(req.query.limit ?? 200), 1, 1000)
    const status = req.query.status
    return {
      rows: repo.applicationHistory(
        status && status !== 'all' ? { limit, status: status as ApplicationStatus } : { limit },
      ),
    }
  })

  app.get('/api/runs', () => ({ rows: repo.recentRuns() }))

  // ------------------------------------------------------------------ actions

  /** "Разобрал руками" — the vacancy leaves the manual queue without a limit being spent. */
  app.post<{ Params: { id: string } }>('/api/needs-human/:id/resolve', (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad application id' })
    repo.resolveNeedsHuman(id)
    pingState('needs-human:resolved')
    return { ok: true, id }
  })

  /**
   * The same, for everything open at once. A queue of twenty is twenty clicks, and a
   * queue nobody clears is a queue nobody reads.
   */
  app.post('/api/needs-human/resolve-all', () => {
    const n = repo.resolveAllNeedsHuman()
    pingState('needs-human:resolved')
    return { ok: true, resolved: n }
  })

  /**
   * Put failures back in the queue. Manual by design (§7): the usual cause is a
   * broken selector, and an automatic retry loop against hh is what turns that into
   * a blocked account. The button is here, the judgement stays with the human.
   */
  app.post<{ Body: { errorCode?: string } }>('/api/failed/requeue', (req) => {
    const code = req.body?.errorCode?.trim() || undefined
    const n = repo.requeueFailed(code)
    pingState('failed:requeued')
    return { ok: true, requeued: n, errorCode: code ?? null }
  })

  /** One failure back in the queue — same manual judgement, per row. */
  app.post<{ Params: { id: string } }>('/api/failed/:id/requeue', (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad application id' })
    if (!repo.requeueFailedOne(id)) return reply.code(409).send({ error: 'not a failed application' })
    pingState('failed:requeued')
    return { ok: true, id }
  })

  /**
   * Turn one failure into `applied`, for when hh shows the response went through
   * despite the failed confirmation. Per row, not per cause: the check is made on hh
   * for a specific vacancy, and a false `applied` is the costly mistake (§5).
   */
  app.post<{ Params: { id: string } }>('/api/failed/:id/mark-applied', (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad application id' })
    if (!repo.markFailedApplied(id)) {
      return reply.code(409).send({ error: 'not a failed application, or the vacancy is already applied' })
    }
    pingState('failed:marked-applied')
    return { ok: true, id }
  })

  /**
   * Approve a letter, with an edit if the text came back changed.
   *
   * The edit path is the point: reading a letter you cannot fix is an inspection, not
   * a review. `approveLetter` marks the row `edited`, so a letter a human rewrote
   * stays distinguishable from one the model got right.
   *
   * Refused mid-run: an apply run reads its letters as it goes, so approving one
   * halfway through means the run either misses it or sends a version nobody saw.
   */
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/api/letters/:id/approve',
    (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad letter id' })

      const running = currentRun()
      if (running) {
        return reply
          .code(409)
          .send({ error: `${running.mode} is running — wait for it to finish`, running })
      }

      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : undefined
      if (text !== undefined && text.length === 0) {
        return reply.code(400).send({ error: 'letter text is empty' })
      }
      repo.approveLetter(id, text)
      pingState('letter:approved')
      return { ok: true, id }
    },
  )

  // --------------------------------------------------------------------- runs

  app.post<{ Params: { mode: string }; Body: { limit?: number; period?: number } }>('/api/run/:mode', (req, reply) => {
    const mode = req.params.mode as RunMode
    if (!RUN_MODES.includes(mode)) return reply.code(404).send({ error: `unknown run mode: ${mode}` })

    const raw = req.body?.limit
    const limit = typeof raw === 'number' && Number.isFinite(raw) ? clamp(Math.trunc(raw), 1, 500) : undefined

    const period = req.body?.period
    if (period !== undefined && !COLLECT_PERIODS.includes(period)) {
      return reply.code(400).send({ error: `period must be one of ${COLLECT_PERIODS.join(', ')}` })
    }

    try {
      return { ok: true, run: startRun(mode, { limit, period }) }
    } catch (e) {
      if (e instanceof BusyError) return reply.code(409).send({ error: e.message, running: e.running })
      throw e
    }
  })

  // ------------------------------------------------------------------- config

  /**
   * Read-only except for dryRun and search.text (below). config.json stays the single
   * validated source of truth; the UI does not re-implement its checks, it reuses the schema.
   */
  app.get('/api/config', () => {
    // The file itself, not the parsed object: the parsed one has every zod default
    // filled in, so it does not show what is actually written down and cannot be
    // compared with the file being edited.
    const path = existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE_PATH
    return {
      path: projectPath(configSource()),
      raw: existsSync(path) ? readFileSync(path, 'utf8') : null,
      warnings: limitWarnings(loadConfig(true)),
      config: loadConfig(true),
    }
  })

  /**
   * The master safety switch, the one setting worth a button.
   *
   * Refused mid-run: the running pipeline read its config at start, so flipping the
   * switch under it would change what the dashboard claims without changing what the
   * run is doing.
   */
  app.post<{ Body: { dryRun?: boolean } }>('/api/config/dry-run', (req, reply) => {
    const running = currentRun()
    if (running) {
      return reply.code(409).send({ error: `${running.mode} is running — stop it before switching modes`, running })
    }
    if (typeof req.body?.dryRun !== 'boolean') {
      return reply.code(400).send({ error: 'dryRun must be true or false' })
    }
    const value = setDryRun(req.body.dryRun)
    pingState('config:dryRun')
    return { ok: true, dryRun: value }
  })

  /**
   * The search query. Same guard as dryRun: a running collect has already built its
   * search URL, so changing the text under it would make the dashboard describe a run
   * that is not happening.
   */
  app.post<{ Body: { text?: string } }>('/api/config/search-text', (req, reply) => {
    const running = currentRun()
    if (running) {
      return reply.code(409).send({ error: `${running.mode} is running — stop it before changing the search`, running })
    }
    if (typeof req.body?.text !== 'string' || !req.body.text.trim()) {
      return reply.code(400).send({ error: 'text must be a non-empty string' })
    }
    try {
      const value = setSearchText(req.body.text)
      pingState('config:searchText')
      return { ok: true, text: value }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
  })

  /**
   * The cover letter: mode, and the static text. Same mid-run guard as the others —
   * an apply run took its letter from the config it read at start.
   */
  app.post<{ Body: { mode?: string; text?: string } }>('/api/config/letter', (req, reply) => {
    const running = currentRun()
    if (running) {
      return reply.code(409).send({ error: `${running.mode} is running — stop it before changing the letter`, running })
    }
    const { mode, text } = req.body ?? {}
    if (mode !== undefined && mode !== 'static' && mode !== 'llm') {
      return reply.code(400).send({ error: "mode must be 'static' or 'llm'" })
    }
    if (text !== undefined && typeof text !== 'string') {
      return reply.code(400).send({ error: 'text must be a string' })
    }
    if (mode === undefined && text === undefined) {
      return reply.code(400).send({ error: 'nothing to change' })
    }
    try {
      const value = setLetter({ mode, text })
      pingState('config:letter')
      return { ok: true, ...value }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
  })

  // --------------------------------------------------------------- screenshots

  /**
   * Screenshots are addressed by file name only and always resolved inside the
   * screenshot directory — the stored paths are absolute, and echoing an absolute
   * path from the database straight into a file read is how a local viewer turns
   * into a "read any file on the disk" endpoint.
   */
  app.get<{ Params: { name: string } }>('/api/screenshot/:name', (req, reply) => {
    const name = basename(req.params.name)
    const path = resolve(SCREENSHOT_DIR, name)
    if (!path.startsWith(SCREENSHOT_DIR) || !existsSync(path)) {
      return reply.code(404).send({ error: 'no such screenshot' })
    }
    return reply.type('image/png').send(createReadStream(path))
  })
}

const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
