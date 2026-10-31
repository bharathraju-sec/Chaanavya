// Outbox delivery (Stage 08). Delivers pending events in order, at least once; a failing handler is
// retried with growing delays (1, 2, 4 ... minutes, at most an hour) and its error kept on the event.
//
// Handlers: the worker (main.ts) delivers catalogue.updated to the storefront cache refresh
// (storefront-refresh.ts, Stage 10.10). `defaultHandlers` only logs, for tests and for a worker run
// without a web host.
import type { Tx } from "@chaanavya/api/db/client"
import type { Logger } from "@chaanavya/shared/observability/logger"
import type { Job } from "../runner.ts"

type Event = { id: string; topic: string; aggregateId: string; payload: unknown; attempts: number; createdAt?: Date }
export type OutboxHandler = (event: Event, logger: Logger) => Promise<void>

export const OUTBOX_BATCH = 100
export const retryDelayMs = (attempts: number) => Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1))

export const defaultHandlers = (logger: Logger): Record<string, OutboxHandler> => ({
  "catalogue.updated": async event => logger.info("outbox.catalogue_updated", { eventId: event.id, productId: event.aggregateId }),
  "order.paid": async event => logger.info("outbox.order_paid", { eventId: event.id, orderId: event.aggregateId }),
})

export function outboxJob(logger: Logger, handlers: Record<string, OutboxHandler> = defaultHandlers(logger)): Job {
  return {
    name: "outbox-delivery",
    lockKey: 7_002,
    everyMs: 15 * 1000,
    async run(tx: Tx) {
      const now = new Date()
      const events = await tx.outboxEvent.findMany({ where: { dispatchedAt: null, availableAt: { lte: now } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: OUTBOX_BATCH })
      let delivered = 0
      let failed = 0
      for (const event of events) {
        const handler = handlers[event.topic]
        try {
          if (!handler) throw new Error(`no handler for ${event.topic}`)
          await handler(event, logger)
          await tx.outboxEvent.update({ where: { id: event.id }, data: { dispatchedAt: new Date(), attempts: { increment: 1 }, lastError: null } })
          delivered++
        } catch (error) {
          const attempts = event.attempts + 1
          await tx.outboxEvent.update({ where: { id: event.id }, data: { attempts, lastError: String((error as Error).message ?? error).slice(0, 500), availableAt: new Date(Date.now() + retryDelayMs(attempts)) } })
          failed++
        }
      }
      return { delivered, failed }
    },
  }
}
