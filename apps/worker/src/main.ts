// Chaanavya worker (Stage 07). Runs the scheduled jobs in ./jobs and answers health probes:
//   GET /health  the process is up
//   GET /ready   the database answers, with each job's last outcome
// Stops cleanly on SIGTERM/SIGINT: no new runs start and running jobs finish first.
import { createServer } from "node:http"
import { createDbClient } from "@chaanavya/api/db/client"
import { settleReservation } from "@chaanavya/api/inventory/reservations"
import { cancelUnpaidOrder } from "@chaanavya/api/orders/cancel"
import { reconcileOrders } from "@chaanavya/api/orders/recovery"
import { mediaStorage } from "@chaanavya/api/media/storage"
import { paymentAdapterFor } from "@chaanavya/api/integrations/payments"
import { PAYMENT_EVENT_TYPES, paymentEventsHandler } from "@chaanavya/api/payments/capture-handler"
import { failureHandler } from "@chaanavya/api/payments/failure-handler"
import { processWebhookInbox } from "@chaanavya/api/payments/inbox"
import { reconcilePayments } from "@chaanavya/api/payments/reconcile"
import { refundEventHandler } from "@chaanavya/api/payments/refund"
import { createLogger } from "@chaanavya/shared/observability/logger"
import { housekeeping } from "./jobs/housekeeping.ts"
import { inventoryReconciliationJob } from "./jobs/inventory-reconciliation.ts"
import { mediaCleanupJob } from "./jobs/media-cleanup.ts"
import { outboxJob } from "./jobs/outbox.ts"
import { paymentInboxJob } from "./jobs/payment-inbox.ts"
import { paymentReconciliationJob } from "./jobs/payment-reconciliation.ts"
import { storefrontRefresh, storefrontTarget } from "./jobs/storefront-refresh.ts"
import { orderExpiryJob } from "./jobs/order-expiry.ts"
import { orderReconciliationJob } from "./jobs/order-reconciliation.ts"
import { reservationExpiryJob } from "./jobs/reservation-expiry.ts"
import { startJobs } from "./runner.ts"

const logger = createLogger({ base: { service: "worker" } })
const db = createDbClient()
// Catalogue changes refresh the storefront's cached pages through the web host (WEB_URL).
const storefront = storefrontTarget(process.env)
// Payment events (Stages 14.12, 14.13): captures from the inbox confirm their orders; failed tries are recorded
// and end nothing; the reconciliation job asks the provider about outcomes nobody told us (14.14). Payments off: idle.
const payments = paymentAdapterFor(process.env)
const paymentInbox = paymentInboxJob(db, processWebhookInbox, payments ? paymentEventsHandler(db, payments, failureHandler(db, payments), refundEventHandler(db, payments)) : null, PAYMENT_EVENT_TYPES)
const outboxHandlers = {
  "catalogue.updated": storefrontRefresh(storefront, logger),
  // Notifications arrive in a later stage; until then a confirmed order is logged (ids and amount only).
  "order.paid": async (event: { id: string; aggregateId: string }) => logger.info("outbox.order_paid", { eventId: event.id, orderId: event.aggregateId }),
}
const jobs = startJobs(db, [housekeeping, outboxJob(logger, outboxHandlers), mediaCleanupJob(mediaStorage), reservationExpiryJob(db, settleReservation), orderExpiryJob(db, cancelUnpaidOrder), orderReconciliationJob(db, reconcileOrders), inventoryReconciliationJob, paymentInbox, paymentReconciliationJob(db, reconcilePayments, payments)], logger)

const port = Number(process.env.WORKER_HEALTH_PORT?.trim() || 4001)
const server = createServer(async (request, response) => {
  const send = (status: number, body: object) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify(body))
  }
  if (request.method !== "GET") return send(405, { error: "method_not_allowed" })
  if (request.url === "/health") return send(200, { status: "ok" })
  if (request.url === "/ready") {
    try {
      await db.$queryRaw`SELECT 1`
      return send(200, { status: "ready", jobs: jobs.statuses() })
    } catch {
      return send(503, { status: "unavailable", jobs: jobs.statuses() })
    }
  }
  return send(404, { error: "not_found" })
})
server.listen(port, "0.0.0.0", () => logger.info("worker.started", { port, jobs: jobs.statuses().length }))

let stopping = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    logger.info("worker.stopping", { signal })
    server.close()
    await jobs.stop()
    await db.$disconnect()
    process.exit(0)
  })
}
