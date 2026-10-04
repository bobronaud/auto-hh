import { z } from 'zod'

/**
 * Search params mirror hh's own search URL. Names follow the OpenAPI spec
 * (RESEARCH §1.3): professional_role is SINGULAR, schedule is deprecated in favour
 * of work_schedule_by_days. We build a search URL from these, not an API call —
 * the hh API is closed (§1.4).
 */
const searchSchema = z.object({
  text: z.string().min(1),
  /** hh search_field: name | company_name | description */
  searchField: z.array(z.enum(['name', 'company_name', 'description'])).default(['name']),
  /**
   * hh area ids (113 = Russia, 1 = Moscow, 2 = SPb). Empty — and that is the default —
   * means no region filter at all: hh then searches everywhere it has vacancies.
   */
  area: z.array(z.string()).default([]),
  experience: z.enum(['noExperience', 'between1And3', 'between3And6', 'moreThan6']).optional(),
  /** Words that disqualify a vacancy outright; passed to hh as excluded_text. */
  excludedText: z.array(z.string()).default([]),
  /** hh work_format: REMOTE | HYBRID | ON_SITE | FIELD_WORK */
  workFormat: z.array(z.enum(['REMOTE', 'HYBRID', 'ON_SITE', 'FIELD_WORK'])).default([]),
  /** Days back to search. 0 means no period at all — hh then searches all time. */
  period: z.number().int().min(0).max(30).default(7),
  /** Max result pages to walk. Each page is one navigation — see §1.4. */
  maxPages: z.number().int().min(1).max(40).default(5),
})

/**
 * Hard filters applied locally before any LLM call (§3.2).
 *
 * Deliberately minimal. The goal of this tool is coverage, so the only question a
 * filter may ask is "is this a frontend vacancy at all". Salary, years of experience
 * and work format are NOT filtered: narrowing on them throws away applications for
 * criteria that are negotiable anyway.
 */
const filtersSchema = z.object({
  /**
   * Vacancies with a test task cannot be answered automatically. false parks them in
   * the manual queue (npm run review); true drops them silently.
   */
  skipWithTest: z.boolean().default(false),
  /** Substrings in company name that disqualify (agencies, known spammers). */
  companyBlacklist: z.array(z.string()).default([]),
  /** Substrings in vacancy title that disqualify. */
  titleBlacklist: z.array(z.string()).default([]),
})

/**
 * Rate limits. hh's own ceiling is 200 per ROLLING 24h across all resumes (§5.1),
 * and the defaults here sit far below it deliberately (§5.2).
 *
 * No upper bound is enforced: this is a personal tool and the account owner decides
 * their own risk. Values above the safe band are warned about at runtime (see
 * `limitWarnings`), never rejected.
 */
const limitsSchema = z.object({
  perDay: z.number().int().min(1).default(30),
  perHour: z.number().int().min(1).default(5),
  /** Base pause between actions, milliseconds. */
  delayMs: z.number().int().min(200).default(800),
  /** Random +/- jitter applied to every pause. */
  delayJitterMs: z.number().int().min(0).default(400),
  /** Extra "reading the page" pause before deciding to apply. */
  readPauseMsMin: z.number().int().min(0).default(1500),
  readPauseMsMax: z.number().int().min(0).default(4000),
  /**
   * Gap between vacancies in an apply run, between the pages read for letter
   * descriptions and between search result pages. 0 = none: the owner traded the
   * human-like pacing for speed (05.10). Everywhere else there are no timers, only
   * waits for DOM state. delayMs/readPause above are left to selectors:probe.
   * Raise this if captchas become frequent.
   */
  gapMs: z.number().int().min(0).default(0),
})

const scoringSchema = z.object({
  /** Weights for the three LLM axes (§3.3). Normalised at use site. */
  weights: z
    .object({
      vacancy: z.number().min(0).default(0.3),
      cvMatch: z.number().min(0).default(0.5),
      overall: z.number().min(0).default(0.2),
    })
    .default({ vacancy: 0.3, cvMatch: 0.5, overall: 0.2 }),
  /** Weighted score below this is never applied to. */
  threshold: z.number().min(0).max(100).default(65),
  /** Cheap keyword prefilter: at least this many must appear before spending tokens. */
  requiredKeywordHits: z.number().int().min(0).default(1),
  keywords: z.array(z.string()).default([]),
})

const letterSchema = z.object({
  /**
   * 'static' sends `text` verbatim with every application — no LLM, no approval step,
   * nothing to review. 'llm' writes a letter per vacancy (slower, needs descriptions).
   */
  mode: z.enum(['static', 'llm']).default('static'),
  /** The letter used in static mode. */
  text: z
    .string()
    .default(
      'Здравствуйте! Работал со всеми технологиями из вашей вакансии. ' +
        'Когда удобно созвониться?',
    ),
  /**
   * Hard character cap.
   *
   * hh's own limit is 10000, read off the field's counter ("88 из 10000") during a
   * dry run — it appears in no documentation and the textarea carries no maxlength
   * attribute, which is why the research left it open. The default here is far lower
   * on purpose: a 10000-character cover letter does not get read.
   */
  maxChars: z.number().int().min(100).max(10_000).default(1000),
  minChars: z.number().int().min(0).default(300),
  /**
   * Hold generated letters until a human approves them.
   *
   * Off by default, and the reason is the same one that runs through the rest of the
   * project: an unapproved letter is an application not sent. Nothing is lost when it
   * is on — apply leaves such a vacancy in the queue rather than recording a skip —
   * but nothing goes out either until someone calls repo.approveLetter.
   */
  requireManualApproval: z.boolean().default(false),
  language: z.enum(['ru', 'en']).default('ru'),
  /**
   * Experience worth writing about that the resume files do not spell out.
   *
   * Appended to the resume in the prompt, never merged into `resume.*.md`: those files
   * mirror the PDFs actually attached to the application and have to keep matching
   * them. Backend work lives here — it is what makes a fullstack posting answerable
   * without claiming anything the candidate cannot back up.
   */
  extraSkills: z.string().default(''),
  /**
   * Letters generated per LLM call.
   *
   * This matters far more than the model choice. Every claude-cli invocation re-sends
   * Claude Code's system prompt, so a batch of 10 measured 24x cheaper per letter
   * than one-at-a-time ($0.0017 vs $0.041). Too large a batch risks a truncated
   * response and dilutes per-vacancy attention; 10 is the measured sweet spot.
   */
  batchSize: z.number().int().min(1).max(25).default(10),
})

const llmSchema = z.object({
  /**
   * 'claude-cli' shells out to the locally installed, already-authenticated `claude`
   * binary. No API key, no separate billing — it draws on the Claude Code
   * subscription. Claude Code's own prompt, tools and MCP servers are switched off
   * per call (see claudeCli.ts), so the overhead is process start-up, not tokens.
   *
   * 'anthropic' calls the API directly and needs a key from console.anthropic.com —
   * cheaper and faster per letter, but separately billed.
   */
  provider: z.enum(['none', 'claude-cli', 'anthropic', 'openrouter', 'ollama']).default('none'),
  /** For claude-cli: 'sonnet' | 'opus' | 'haiku' or a full model id. */
  model: z.string().default(''),
  /** Read from env, never stored in config.json. Unused by claude-cli. */
  apiKeyEnv: z.string().default('LLM_API_KEY'),
  baseUrl: z.string().url().optional(),
  /** claude-cli spawns a process per call — keep this low. */
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  /** Seconds before a single generation is abandoned. */
  timeoutSec: z.number().int().min(10).max(600).default(120),
})

const browserSchema = z.object({
  /** headless is opt-in, never the default (§2.2). DDoS-Guard is harsher on it. */
  headless: z.boolean().default(false),
  locale: z.string().default('ru-RU'),
  timezone: z.string().default('Europe/Moscow'),
  /**
   * Milliseconds to wait for the user to finish a manual login / captcha.
   *
   * 20 minutes, not 5: this is also how long a run pauses mid-flight when hh raises
   * a captcha (waitOutCaptcha), and a run that gives up before the owner walks back
   * to the keyboard throws away the queue it was halfway through.
   */
  manualActionTimeoutMs: z.number().int().min(30_000).default(1_200_000),
  slowMoMs: z.number().int().min(0).default(0),
})

/**
 * One resume per stack. hh's apply modal has a resume dropdown, so the same run can
 * answer a React vacancy with the React resume and a Vue one with the Vue resume —
 * the vacancy decides, not the config.
 */
const resumeSchema = z.object({
  /** Exactly as it reads in hh's resume dropdown — this is how we pick it. */
  title: z.string().min(1),
  /** Short id used in logs and the UI. */
  id: z.string().min(1),
  /** Stack markers. A hit in the vacancy title counts far more than one in the body. */
  match: z.array(z.string().min(1)).min(1),
  /** Markers that disqualify this resume even when `match` hits. */
  exclude: z.array(z.string()).default([]),
  /** Path to the plain-text resume fed to the LLM when writing the letter. */
  file: z.string().default(''),
})

/**
 * Which resume answers which vacancy.
 *
 * The rule is deliberately asymmetric: a specialised resume wins only when the
 * vacancy clearly calls for it, and everything else goes to the fallback. Nothing is
 * ever skipped for being ambiguous — coverage is the point of this tool, and a
 * generalist Frontend resume is a defensible answer to an ambiguous Frontend vacancy.
 */
const routingSchema = z.object({
  /** Resume used whenever no other one clearly wins. Must name a real resume id. */
  fallbackResumeId: z.string().min(1),
  /** A title hit is worth this many body hits. */
  titleWeight: z.number().min(1).default(5),
  /** Minimum score before a resume is considered a match at all. */
  minScore: z.number().min(1).default(1),
})

export const configSchema = z.object({
  /**
   * Master safety switch. While true nothing is ever submitted to hh — the pipeline
   * runs end to end and stops before the final click (§8, stage 6.7).
   */
  dryRun: z.boolean().default(true),
  resumes: z.array(resumeSchema).min(1),
  routing: routingSchema,
  search: searchSchema,
  filters: filtersSchema.default({}),
  limits: limitsSchema.default({}),
  scoring: scoringSchema.default({}),
  letter: letterSchema.default({}),
  llm: llmSchema.default({}),
  browser: browserSchema.default({}),
})
  .superRefine((cfg, ctx) => {
    const ids = cfg.resumes.map((r) => r.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resumes'], message: 'resume ids must be unique' })
    }
    if (!ids.includes(cfg.routing.fallbackResumeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routing', 'fallbackResumeId'],
        message: `must be one of: ${ids.join(', ')}`,
      })
    }
  })

export type Config = z.infer<typeof configSchema>
export type ResumeConfig = z.infer<typeof resumeSchema>
export type RoutingConfig = z.infer<typeof routingSchema>
export type SearchConfig = z.infer<typeof searchSchema>
export type LimitsConfig = z.infer<typeof limitsSchema>

/** hh's hard ceiling, for comparison only — not enforced. */
export const HH_DAILY_CEILING = 200

/**
 * Advisory warnings for a configuration that raises the risk of a block.
 * Returns an empty list for the safe defaults.
 */
export function limitWarnings(cfg: Config): string[] {
  const w: string[] = []
  const { perDay, perHour, delayMs, delayJitterMs } = cfg.limits

  if (perDay > HH_DAILY_CEILING) {
    w.push(
      `limits.perDay=${perDay} exceeds hh's own ceiling of ${HH_DAILY_CEILING} per rolling 24h — ` +
        'the surplus cannot be sent and will come back as limit_exceeded.',
    )
  } else if (perDay > 50) {
    w.push(`limits.perDay=${perDay} is well above the researched safe band (~30/day).`)
  }

  if (perHour > 20) {
    w.push(`limits.perHour=${perHour} is a burst rate no human matches (~5/hour is the safe band).`)
  }
  if (perHour > perDay) {
    w.push(`limits.perHour=${perHour} is above limits.perDay=${perDay} — the daily cap binds first.`)
  }
  if (delayMs - delayJitterMs < 300) {
    w.push(`limits.delayMs=${delayMs} ±${delayJitterMs} can produce sub-300ms pauses — an obvious bot signature.`)
  }
  if (!cfg.letter.requireManualApproval && cfg.llm.provider === 'none') {
    w.push('letter.requireManualApproval=false with no LLM configured — letters would be empty.')
  }
  return w
}
