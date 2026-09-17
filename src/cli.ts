import { loadConfig, configSource } from './config/load.js'
import { limitWarnings } from './config/schema.js'
import { login, health } from './hh/auth.js'
import { probe } from './hh/probe.js'
import { getDb, closeDb } from './db/index.js'
import { Repo } from './db/repo.js'
import { isConfigured } from './llm/provider.js'
import { BROWSER_PROFILE_DIR } from './core/paths.js'
import { existsSync, readdirSync } from 'node:fs'

const [, , command] = process.argv

async function main(): Promise<void> {
  switch (command) {
    case 'login':
      await login(loadConfig())
      break

    case 'probe':
      await probe(loadConfig())
      break

    case 'doctor':
      await doctor()
      break

    case 'review':
      review()
      break

    case 'resolve': {
      const id = Number(process.argv[3])
      if (!Number.isInteger(id)) throw new Error('Usage: npm run resolve -- <application id>')
      new Repo().resolveNeedsHuman(id)
      console.log(`#${id} marked as handled.`)
      break
    }

    default:
      console.log(`
head-hunter-hunter

  npm run login            Log in to hh.ru by hand, once. Saves the browser profile.
  npm run doctor           Check config, database, session — without touching hh.
  npm run selectors:probe  Verify every selector against live hh.ru (research stage 0).
  npm run review           List vacancies parked for manual handling.
  npm run resolve -- <id>  Mark one parked vacancy as handled.
`)
      process.exitCode = command ? 1 : 0
  }
}

/**
 * The manual-work queue. These are vacancies the bot refused on purpose — employer
 * questions, tests, external ATS — not failures. Printed with full URLs so they can
 * be walked through by hand.
 */
function review(): void {
  const rows = new Repo().needsHuman()
  if (rows.length === 0) {
    console.log('\nNothing parked for manual handling.\n')
    return
  }
  console.log(`\n${rows.length} vacancies need you:\n`)
  for (const r of rows) {
    const reason = r.needs_human_reason ?? 'unknown'
    console.log(`  #${r.application_id}  ${r.title}`)
    console.log(`      ${r.company ?? '—'} · ${reason} · ${r.created_at.slice(0, 16).replace('T', ' ')}`)
    console.log(`      ${r.url}`)
  }
  console.log(`\n  Handled one? npm run resolve -- <id>\n`)
}

/** Everything checkable without making a single request to hh. */
async function doctor(): Promise<void> {
  const cfg = loadConfig()
  console.log(`\nconfig      ${configSource()}`)
  console.log(`dryRun      ${cfg.dryRun ? 'true  — nothing will ever be submitted' : 'FALSE — real applications will be sent'}`)
  console.log(`search      "${cfg.search.text}" · area ${cfg.search.area.join(',')} · ${cfg.search.maxPages} pages`)
  for (const r of cfg.resumes) {
    console.log(`resume      ${r.id.padEnd(6)} "${r.title}"  ← ${r.match.join(', ')}`)
  }
  console.log(`routing     fallback=${cfg.routing.fallbackResumeId || '(none, skip)'} · ties ${cfg.routing.skipOnTie ? 'skipped' : 'sent to fallback'}`)
  console.log(`limits      ${cfg.limits.perDay}/day, ${cfg.limits.perHour}/hour (hh ceiling: 200 per rolling 24h)`)
  console.log(`letter cap  ${cfg.letter.maxChars} chars ${cfg.letter.requireManualApproval ? '(manual approval on)' : '(NO manual approval)'}`)
  console.log(`llm         ${isConfigured(cfg) ? `${cfg.llm.provider} / ${cfg.llm.model}` : 'none — scoring and letters are not wired yet'}`)

  for (const w of limitWarnings(cfg)) console.log(`\n  ⚠ ${w}`)

  getDb()
  const repo = new Repo()
  console.log(`\ndatabase    ok`)
  console.log(`applied     ${repo.countAppliedWithin(24)} in the last rolling 24h, ${repo.countAppliedWithin(1)} in the last hour`)
  const parked = repo.countNeedsHuman()
  if (parked > 0) console.log(`parked      ${parked} awaiting manual handling — npm run review`)

  const hasProfile = existsSync(BROWSER_PROFILE_DIR) && readdirSync(BROWSER_PROFILE_DIR).length > 0
  console.log(`profile     ${hasProfile ? BROWSER_PROFILE_DIR : 'missing — run `npm run login`'}`)

  if (hasProfile) {
    console.log(`\nChecking the hh session (one request)...`)
    const h = await health(cfg)
    console.log(`session     ${h.loggedIn ? 'logged in' : `NOT usable — state=${h.state}`}`)
    if (h.screenshot) console.log(`screenshot  ${h.screenshot}`)
  }
  console.log()
}

main()
  .catch((e: unknown) => {
    console.error(`\n${(e as Error).message}\n`)
    process.exitCode = 1
  })
  .finally(closeDb)
