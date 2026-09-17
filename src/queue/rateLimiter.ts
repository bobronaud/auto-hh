import { Repo } from '../db/repo.js'
import type { Config } from '../config/schema.js'

/**
 * Rolling-window rate limiting (RESEARCH §5.1).
 *
 * hh's own ceiling is 200 per rolling 24 hours across all resumes — *rolling*, not
 * per calendar day. A counter that resets at midnight drifts out of sync with hh and
 * starts collecting limit_exceeded errors, which is exactly the failure reported in
 * axisrow/hhru#1142. Everything here counts backwards from now.
 */

export interface LimitState {
  allowed: boolean
  reason?: 'day' | 'hour'
  usedDay: number
  usedHour: number
  remainingDay: number
  remainingHour: number
  /** When the next slot frees up, if currently blocked. */
  nextSlotAt?: string
}

export class RateLimiter {
  constructor(
    private readonly cfg: Config,
    private readonly repo: Repo = new Repo(),
  ) {}

  check(): LimitState {
    const usedDay = this.repo.countAppliedWithin(24)
    const usedHour = this.repo.countAppliedWithin(1)
    const { perDay, perHour } = this.cfg.limits

    const state: LimitState = {
      allowed: true,
      usedDay,
      usedHour,
      remainingDay: Math.max(0, perDay - usedDay),
      remainingHour: Math.max(0, perHour - usedHour),
    }

    if (usedDay >= perDay) {
      state.allowed = false
      state.reason = 'day'
      state.nextSlotAt = this.freesAt(24)
    } else if (usedHour >= perHour) {
      state.allowed = false
      state.reason = 'hour'
      state.nextSlotAt = this.freesAt(1)
    }
    return state
  }

  /**
   * A slot opens when the oldest application inside the window leaves it — which is
   * the oldest timestamp plus the window, not the top of the next hour.
   */
  private freesAt(hours: number): string | undefined {
    const oldest = this.repo.oldestAppliedWithin(hours)
    if (!oldest) return undefined
    return new Date(new Date(oldest).getTime() + hours * 3600_000).toISOString()
  }

  /** How many more can be sent right now, honouring both windows. */
  budget(): number {
    const s = this.check()
    return s.allowed ? Math.min(s.remainingDay, s.remainingHour) : 0
  }
}

export function describeLimit(s: LimitState): string {
  if (s.allowed) return `${s.usedDay} sent in 24h, ${s.usedHour} in 1h — ${Math.min(s.remainingDay, s.remainingHour)} left now`
  const when = s.nextSlotAt ? ` — next slot ${new Date(s.nextSlotAt).toLocaleTimeString('ru-RU')}` : ''
  return s.reason === 'day'
    ? `daily limit reached (${s.usedDay})${when}`
    : `hourly limit reached (${s.usedHour})${when}`
}
