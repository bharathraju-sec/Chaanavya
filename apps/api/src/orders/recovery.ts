// Order recovery reconciliation (Stage 13.14). Finds orders and stock holds that are stuck and opens a case
// for a person to look at. It never changes an order, a payment or a stock hold, and never decides how a
// payment ended: where the outcome is unknown, the case says to ask the payment provider.
//
// Stuck means, `GRACE_MS` after the deadline that should have moved it (so the regular jobs get their turn):
//   pending_past_window     a pending order from a quote whose payment window has passed (order expiry did
//                           not cancel it, usually because a payment is still in flight)
//   captured_not_confirmed  a captured payment on an order still pending payment
//   hold_overdue            an active stock hold past its expiry (reservation expiry did not settle it)
//   hold_mismatch           the order and its hold disagree: a pending order with no stock held, a confirmed
//                           order whose stock is not allocated, a cancelled order still holding stock
//   review_waiting          an order left in needs review for `REVIEW_WAIT_MS`
//
// Cases  one open case per order and kind (partial unique index), so a repeated or overlapping run never
//        opens a second; a run refreshes what it sees again, and clears a case whose condition has gone.
//        A case staff resolved is not reopened while the facts stay the same. Facts are statuses, ids and
//        times only. Every open, clear and resolve is audited.
import { createHash } from "node:crypto"
import { ApiError, pageOf } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db } from "../db/client.ts"
import { isDuplicateKey } from "../inventory/ledger.ts"

export const GRACE_MS = 15 * 60 * 1000
export const REVIEW_WAIT_MS = 24 * 60 * 60 * 1000
export const RECOVERY_BATCH = 500

export const CASE_KINDS = ["pending_past_window", "captured_not_confirmed", "hold_overdue", "hold_mismatch", "review_waiting"] as const
export type CaseKind = (typeof CASE_KINDS)[number]
export const CASE_STATUSES = ["open", "resolved", "cleared"] as const

const IN_FLIGHT = ["created", "authorized", "pending_reconciliation"]

type Candidate = {
  id: string
  status: string
  fulfilmentStatus: string
  quoteRef: string | null
  payableUntil: Date | null
  heldAt: Date | null
  createdAt: Date
  updatedAt: Date
  payments: { status: string; updatedAt: Date }[]
  reservation: { status: string; expiresAt: Date } | null
}

export type Finding = { orderId: string; kind: CaseKind; check: string; facts: Record<string, unknown> }

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

/** What a person sees: statuses and deadlines, never a name, contact, key or provider id. */
const factsOf = (o: Candidate) => ({
  orderStatus: o.status,
  fulfilmentStatus: o.fulfilmentStatus,
  payableUntil: iso(o.payableUntil),
  paymentStatuses: o.payments.map(p => p.status).sort(),
  holdStatus: o.reservation?.status ?? null,
  holdExpiresAt: iso(o.reservation?.expiresAt),
  onHold: o.heldAt !== null,
})

/** The stuck conditions one order meets now. Pure: exported for tests. */
export function findingsFor(o: Candidate, now: Date): Finding[] {
  const graceAgo = now.getTime() - GRACE_MS
  const facts = factsOf(o)
  const inFlight = o.payments.some(p => IN_FLIGHT.includes(p.status))
  const captured = o.payments.some(p => p.status === "captured")
  const hold = o.reservation
  const found: Finding[] = []
  const add = (kind: CaseKind, check: string) => found.push({ orderId: o.id, kind, check, facts })

  if (o.status === "pending_payment" && o.quoteRef !== null && o.payableUntil && o.payableUntil.getTime() <= graceAgo) {
    add("pending_past_window", inFlight ? "ask_the_payment_provider_for_the_outcome" : captured ? "captured_payment_waits_for_confirmation" : "order_expiry_did_not_cancel")
  }
  if (o.status === "pending_payment" && o.payments.some(p => p.status === "captured" && p.updatedAt.getTime() <= graceAgo)) {
    add("captured_not_confirmed", "check_the_stock_then_confirm_or_review")
  }
  if (hold?.status === "active" && hold.expiresAt.getTime() <= graceAgo) {
    add("hold_overdue", inFlight ? "ask_the_payment_provider_for_the_outcome" : "reservation_expiry_did_not_settle")
  }
  if (o.status === "pending_payment" && o.quoteRef !== null && o.createdAt.getTime() <= graceAgo && (!hold || hold.status === "released" || hold.status === "fulfilled")) {
    add("hold_mismatch", "pending_order_without_stock_held")
  } else if (o.status === "confirmed" && hold && (hold.status === "active" || hold.status === "released") && o.updatedAt.getTime() <= graceAgo) {
    add("hold_mismatch", "confirmed_order_without_allocated_stock")
  } else if (o.status === "cancelled" && hold?.status === "active" && o.updatedAt.getTime() <= graceAgo) {
    add("hold_mismatch", "cancelled_order_still_holds_stock")
  }
  if (o.status === "needs_review" && o.updatedAt.getTime() <= now.getTime() - REVIEW_WAIT_MS) {
    add("review_waiting", "review_the_order")
  }
  return found
}

const keyOf = (f: Pick<Finding, "kind" | "facts">) => createHash("sha256").update(JSON.stringify([f.kind, f.facts])).digest("hex")
const SYSTEM = { kind: "system" as const, process: "order-reconciliation" }

/** Orders that may be stuck, or have an open case to re-check. Reads only. */
async function candidates(db: Db, now: Date): Promise<Candidate[]> {
  const graceAgo = new Date(now.getTime() - GRACE_MS)
  return db.order.findMany({
    where: {
      OR: [
        { status: "pending_payment", createdAt: { lte: graceAgo } },
        { status: "needs_review", updatedAt: { lte: new Date(now.getTime() - REVIEW_WAIT_MS) } },
        { status: { in: ["confirmed", "cancelled"] }, reservation: { status: { in: ["active", "released"] } } },
        { reservation: { status: "active", expiresAt: { lte: graceAgo } } },
        { recoveryCases: { some: { status: "open" } } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: RECOVERY_BATCH,
    select: {
      id: true,
      status: true,
      fulfilmentStatus: true,
      quoteRef: true,
      payableUntil: true,
      heldAt: true,
      createdAt: true,
      updatedAt: true,
      payments: { select: { status: true, updatedAt: true } },
      reservation: { select: { status: true, expiresAt: true } },
    },
  })
}

export type ReconcileResult = { checked: number; opened: number; refreshed: number; cleared: number; acknowledged: number; failed: number }

/** One reconciliation run. Each case is written on its own transaction; orders, payments and holds are only read. */
export async function reconcileOrders(db: Db, now = new Date()): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, opened: 0, refreshed: 0, cleared: 0, acknowledged: 0, failed: 0 }
  const orders = await candidates(db, now)
  result.checked = orders.length
  for (const order of orders) {
    const findings = findingsFor(order, now)
    try {
      await db.$transaction(async tx => {
        const open = await tx.orderRecoveryCase.findMany({ where: { orderId: order.id, status: "open" } })
        for (const f of findings) {
          const factsKey = keyOf(f)
          const current = open.find(c => c.kind === f.kind)
          if (current) {
            await tx.orderRecoveryCase.update({ where: { id: current.id }, data: { lastSeenAt: now, ...(current.factsKey !== factsKey && { facts: f.facts as object, factsKey, check: f.check }) } })
            result.refreshed++
          } else if (await tx.orderRecoveryCase.findFirst({ where: { orderId: f.orderId, kind: f.kind, status: "resolved", factsKey }, select: { id: true } })) {
            result.acknowledged++ // staff already looked at exactly this; it opens again only if something changes
          } else {
            const created = await tx.orderRecoveryCase.create({ data: { orderId: f.orderId, kind: f.kind, facts: f.facts as object, factsKey, check: f.check, detectedAt: now, lastSeenAt: now } })
            await recordAdminEvent(tx, { action: "order.recovery_case_opened", actor: SYSTEM, entity: { type: "order_recovery_case", id: created.id }, reason: f.check, after: { orderId: f.orderId, kind: f.kind }, correlationId: `worker:order-reconciliation:${created.id}` })
            result.opened++
          }
        }
        for (const gone of open.filter(c => !findings.some(f => f.kind === c.kind))) {
          await tx.orderRecoveryCase.update({ where: { id: gone.id }, data: { status: "cleared", closedAt: now } })
          await recordAdminEvent(tx, { action: "order.recovery_case_cleared", actor: SYSTEM, entity: { type: "order_recovery_case", id: gone.id }, reason: "condition_no_longer_holds", after: { orderId: gone.orderId, kind: gone.kind }, correlationId: `worker:order-reconciliation:${gone.id}` })
          result.cleared++
        }
      })
    } catch (error) {
      // A concurrent run opened the same case first: its case stands.
      if (!isDuplicateKey(error)) result.failed++
    }
  }
  return result
}

// ---- staff: list and resolve -----------------------------------------------------------------

export type CaseCursor = { detectedAt: string; id: string }
export const isCaseCursor = (v: unknown): v is CaseCursor => typeof (v as CaseCursor)?.detectedAt === "string" && typeof (v as CaseCursor)?.id === "string"

type CaseRow = { id: string; orderId: string; kind: string; status: string; facts: unknown; check: string; detectedAt: Date; lastSeenAt: Date; closedAt: Date | null; closedBy: string | null; resolution: string | null; order: { number: string } }

const caseView = (c: CaseRow) => ({
  id: c.id,
  orderId: c.orderId,
  orderNumber: c.order.number,
  kind: c.kind,
  status: c.status,
  check: c.check,
  facts: c.facts,
  detectedAt: c.detectedAt,
  lastSeenAt: c.lastSeenAt,
  closedAt: c.closedAt,
  closedBy: c.closedBy,
  resolution: c.resolution,
})

export async function listCases(db: Db, filters: { status: string | null; kind: string | null; orderId: string | null }, { limit, after }: { limit: number; after: CaseCursor | null }) {
  const at = after ? new Date(after.detectedAt) : null
  if (at && Number.isNaN(at.getTime())) throw new ApiError(400, "invalid_request", "cursor is malformed", { cursor: "malformed" })
  const rows = await db.orderRecoveryCase.findMany({
    where: {
      ...(filters.status && { status: filters.status }),
      ...(filters.kind && { kind: filters.kind }),
      ...(filters.orderId && { orderId: filters.orderId }),
      ...(at && after && { OR: [{ detectedAt: { lt: at } }, { detectedAt: at, id: { lt: after.id } }] }),
    },
    orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { order: { select: { number: true } } },
  })
  const { items, nextCursor } = pageOf(rows, limit, r => ({ detectedAt: r.detectedAt.toISOString(), id: r.id }))
  return { items: items.map(caseView), nextCursor }
}

/** Staff close a case with a reason. It changes nothing on the order: fixing it is a separate, audited action. */
export async function resolveCase(db: Db, caseId: string, reason: string, staff: { userId: string }, correlationId: string) {
  return db.$transaction(async tx => {
    const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "order_recovery_case" WHERE id = ${caseId}::uuid FOR UPDATE`
    if (!row) throw new ApiError(404, "not_found", "not found")
    if (row.status !== "open") throw new ApiError(409, "conflict", `the case is already ${row.status}; nothing was changed`)
    const updated = await tx.orderRecoveryCase.update({ where: { id: caseId }, data: { status: "resolved", closedAt: new Date(), closedBy: staff.userId, resolution: reason }, include: { order: { select: { number: true } } } })
    await recordAdminEvent(tx, { action: "order.recovery_case_resolved", actor: { kind: "staff", id: staff.userId }, entity: { type: "order_recovery_case", id: caseId }, reason, before: { status: "open" }, after: { status: "resolved" }, correlationId })
    return caseView(updated)
  })
}

