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
  /** hh area id. 113 = Russia, 1 = Moscow, 2 = Saint Petersburg. */
  area: z.array(z.string()).default(['113']),
  experience: z.enum(['noExperience', 'between1And3', 'between3And6', 'moreThan6']).optional(),
  /** Words that disqualify a vacancy outright; passed to hh as excluded_text. */
  excludedText: z.array(z.string()).default([]),
  /** hh work_format: REMOTE | HYBRID | ON_SITE | FIELD_WORK */
  workFormat: z.array(z.enum(['REMOTE', 'HYBRID', 'ON_SITE', 'FIELD_WORK'])).default([]),
  /** Days back to search. */
  period: z.number().int().min(1).max(30).default(7),
  /** Max result pages to walk. Each page is one navigation — see §1.4. */
  maxPages: z.number().int().min(1).max(40).default(5),
})

/** Hard filters applied locally before any LLM call (§3.2). */
const filtersSchema = z.object({
  skipWithTest: z.boolean().default(true),
  /** Substrings in company name that disqualify (agencies, known spammers). */
  companyBlacklist: z.array(z.string()).default([]),
  /** Substrings in vacancy title that disqualify. */
  titleBlacklist: z.array(z.string()).default([]),
  minSalary: z.number().int().nonnegative().optional(),
  /** Keep vacancies with no salary stated. */
  allowNoSalary: z.boolean().default(true),
})

/**
 * Rate limits. hh's ceiling is 200 per ROLLING 24h across all resumes (§5.1);
 * these defaults sit far below it deliberately (§5.2).
 */
const limitsSchema = z.object({
  perDay: z.number().int().min(1).max(200).default(30),
  perHour: z.number().int().min(1).max(50).default(5),
  /** Base pause between actions, milliseconds. */
  delayMs: z.number().int().min(200).default(800),
  /** Random +/- jitter applied to every pause. */
  delayJitterMs: z.number().int().min(0).default(400),
  /** Extra "reading the page" pause before deciding to apply. */
  readPauseMsMin: z.number().int().min(0).default(1500),
  readPauseMsMax: z.number().int().min(0).default(4000),
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
   * Hard character cap. hh returns too_long_message past its own limit (§4.2), but
   * the exact number is NOT documented anywhere — measure it in the UI (recon 0.4)
   * and set this below what you measure.
   */
  maxChars: z.number().int().min(100).default(1800),
  minChars: z.number().int().min(0).default(300),
  /** Never send a generated letter without a human seeing it first. */
  requireManualApproval: z.boolean().default(true),
  language: z.enum(['ru', 'en']).default('ru'),
})

const llmSchema = z.object({
  /** 'none' keeps the pipeline runnable before a provider is chosen (stage 4-5). */
  provider: z.enum(['none', 'anthropic', 'openrouter', 'ollama']).default('none'),
  model: z.string().default(''),
  /** Read from env, never stored in config.json. */
  apiKeyEnv: z.string().default('LLM_API_KEY'),
  baseUrl: z.string().url().optional(),
  maxConcurrency: z.number().int().min(1).max(8).default(2),
})

const browserSchema = z.object({
  /** headless is opt-in, never the default (§2.2). DDoS-Guard is harsher on it. */
  headless: z.boolean().default(false),
  locale: z.string().default('ru-RU'),
  timezone: z.string().default('Europe/Moscow'),
  /** Milliseconds to wait for the user to finish a manual login / captcha. */
  manualActionTimeoutMs: z.number().int().min(30_000).default(300_000),
  slowMoMs: z.number().int().min(0).default(0),
})

export const configSchema = z.object({
  /**
   * Master safety switch. While true nothing is ever submitted to hh — the pipeline
   * runs end to end and stops before the final click (§8, stage 6.7).
   */
  dryRun: z.boolean().default(true),
  /** Resume title as it appears in hh's resume picker, used to select the right one. */
  resumeTitle: z.string().default(''),
  /** Path to a plain-text/markdown summary of your resume, fed to the LLM. */
  resumeFile: z.string().default('resume.md'),
  search: searchSchema,
  filters: filtersSchema.default({}),
  limits: limitsSchema.default({}),
  scoring: scoringSchema.default({}),
  letter: letterSchema.default({}),
  llm: llmSchema.default({}),
  browser: browserSchema.default({}),
})

export type Config = z.infer<typeof configSchema>
export type SearchConfig = z.infer<typeof searchSchema>
export type LimitsConfig = z.infer<typeof limitsSchema>
