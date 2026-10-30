// Durable job runner (Stage 07). Each job runs on an interval; a PostgreSQL advisory lock makes sure
// only one worker instance runs a given job at a time, so the worker can be scaled or restarted
// without double work. State lives in the database, not in this process: a crash loses nothing,
// and the next run picks up where the data stands.
//
// Jobs: auth housekeeping (Stage 07), outbox delivery and media clean-up (Stage 08), reservation
// expiry and inventory reconciliation (Stage 09), order expiry (Stage 13.09) and order recovery
// reconciliation (Stage 13.14). Payment reconciliation (Stage 14) and notification dispatch
// (Stage 18, outbox) are added as further jobs.
import type { Db, Tx } from "@chaanavya/api/db/client"
import type { Logger } from "@chaanavya/shared/observability/logger"

export type JobResult = Record<string, number>

export type Job = {
  name: string
  /** Unique advisory-lock key for this job. Never reuse a key for a different job. */
  lockKey: number
  everyMs: number
  /** Runs inside the transaction that holds the job's lock. */
  run: (tx: Tx) => Promise<JobResult>
}

export type JobStatus = { name: string; lastStartedAt: string | null; lastFinishedAt: string | null; lastOutcome: "ok" | "skipped" | "failed" | null; runs: number }

/** Runs `job` once if no other instance holds its lock. Returns "skipped" when another instance does. */
export async function runOnce(db: Db, job: Job, logger: Logger): Promise<"ok" | "skipped" | "failed"> {
  // A session-level lock needs one dedicated connection; an interactive transaction pins one and
  // pg_try_advisory_xact_lock releases automatically at commit or rollback, even if the process dies.
  try {
    return await db.$transaction(
      async tx => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${job.lockKey}::bigint) AS locked`
        if (!locked) return "skipped" as const
        const started = Date.now()
        const result = await job.run(tx)
        logger.info("worker.job_finished", { job: job.name, durationMs: Date.now() - started, ...result })
        return "ok" as const
      },
      { timeout: 5 * 60_000, maxWait: 10_000 },
    )
  } catch (error) {
    logger.error("worker.job_failed", { job: job.name, error })
    return "failed"
  }
}

/** Starts every job on its interval. Returns a stop function that waits for running jobs to finish. */
export function startJobs(db: Db, jobs: readonly Job[], logger: Logger) {
  const statuses = new Map<string, JobStatus>(jobs.map(j => [j.name, { name: j.name, lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, runs: 0 }]))
  const running = new Set<Promise<unknown>>()
  const timers: NodeJS.Timeout[] = []
  let stopping = false

  const tick = (job: Job) => {
    if (stopping) return
    const status = statuses.get(job.name)!
    if (status.lastStartedAt && !status.lastFinishedAt) return
    status.lastStartedAt = new Date().toISOString()
    status.lastFinishedAt = null
    const run = runOnce(db, job, logger).then(outcome => {
      status.lastOutcome = outcome
      status.lastFinishedAt = new Date().toISOString()
      status.runs += 1
    })
    running.add(run)
    void run.finally(() => running.delete(run))
  }

  for (const job of jobs) {
    tick(job)
    timers.push(setInterval(() => tick(job), job.everyMs))
  }

  return {
    statuses: () => [...statuses.values()],
    async stop() {
      stopping = true
      for (const timer of timers) clearInterval(timer)
      await Promise.allSettled([...running])
    },
  }
}
