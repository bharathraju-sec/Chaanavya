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
import { createLogger } from "@chaanavya/shared/observability/logger"
import { housekeeping } from "./jobs/housekeeping.ts"
import { inventoryReconciliationJob } from "./jobs/inventory-reconciliation.ts"
import { mediaCleanupJob } from "./jobs/media-cleanup.ts"
import { outboxJob } from "./jobs/outbox.ts"
import { storefrontRefresh, storefrontTarget } from "./jobs/storefront-refresh.ts"
import { orderExpiryJob } from "./jobs/order-expiry.ts"
import { orderReconciliationJob } from "./jobs/order-reconciliation.ts"
import { reservationExpiryJob } from "./jobs/reservation-expiry.ts"
import { startJobs } from "./runner.ts"

const logger = createLogger({ base: { service: "worker" } })
const db = createDbClient()
// Catalogue changes refresh the storefront's cached pages through the web host (WEB_URL).
const storefront = storefrontTarget(process.env)
const jobs = startJobs(db, [housekeeping, outboxJob(logger, { "catalogue.updated": storefrontRefresh(storefront, logger) }), mediaCleanupJob(mediaStorage), reservationExpiryJob(db, settleReservation), orderExpiryJob(db, cancelUnpaidOrder), orderReconciliationJob(db, reconcileOrders), inventoryReconciliationJob], logger)

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
