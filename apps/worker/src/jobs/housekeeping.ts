// Sign-in housekeeping (decision 024: expired sessions are deleted). Removes only rows that can no
// longer be used: sessions and one-time codes past their expiry, and rate-limit counters idle for a
// day. Guest sessions are kept: guest orders still point at them.
import type { Tx } from "@chaanavya/api/db/client"
import type { Job } from "../runner.ts"

export const RATE_LIMIT_IDLE_MS = 24 * 60 * 60 * 1000

export const housekeeping: Job = {
  name: "auth-housekeeping",
  lockKey: 7_001,
  everyMs: 60 * 60 * 1000,
  async run(tx: Tx) {
    const now = new Date()
    const sessions = await tx.authSession.deleteMany({ where: { expiresAt: { lt: now } } })
    const codes = await tx.verification.deleteMany({ where: { expiresAt: { lt: now } } })
    const counters = await tx.rateLimit.deleteMany({ where: { lastRequest: { lt: BigInt(now.getTime() - RATE_LIMIT_IDLE_MS) } } })
    return { expiredSessions: sessions.count, expiredCodes: codes.count, idleRateLimits: counters.count }
  },
}
