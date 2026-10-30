// Stock reservations (Stage 09). Checkout (Stage 11) reserves when the shopper confirms the order,
// never when a product is added to the bag. A reservation holds every line or none, for a bounded
// time, and leaves through RESERVATION_MACHINE exactly once:
//
//   active -> allocated   payment captured for the full amount (reserved units become allocated)
//   active -> released    hold expired, payment failed or expired, or order cancelled
//
// Each transition is a compare-and-set on the reservation's status plus one ledger movement per
// line with an idempotency key derived from the reservation, so a retried worker run, a duplicate
// event or two workers racing cannot release or allocate twice (CHV-S09-002, CHV-S09-005).
import { planTransition, RESERVATION_MACHINE, type GuardFacts, type PaymentStatus, type ReservationStatus } from "@chaanavya/contracts/modules/state-machines"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db, Tx } from "../db/client.ts"
import { declareOrigin } from "../db/origin.ts"
import { transitionOrder } from "../db/transitions.ts"
import { applyMovement, InsufficientStockError, isDuplicateKey } from "./ledger.ts"

export const RESERVATION_TTL = { minSeconds: 60, maxSeconds: 30 * 60, defaultSeconds: 15 * 60 }
/** A payment still in flight (authorized, being reconciled) keeps its hold this long past expiry. */
export const PAYMENT_GRACE_MS = 30 * 60 * 1000

export type ReserveInput = { orderId: string; lines: { variantId: string; quantity: number }[]; ttlSeconds?: number; idempotencyKey: string; correlationId: string }
export type ReserveResult =
  | { ok: true; reservationId: string; expiresAt: Date; replayed: boolean }
  | { ok: false; reason: "out_of_stock"; variantIds: string[] }
  | { ok: false; reason: "not_sellable"; variantIds: string[] }
  | { ok: false; reason: "invalid" | "order_not_pending" | "key_reused"; detail: string }

const SYSTEM = { kind: "system" as const, process: "inventory" }

type ReserveLines = { ok: true; ttl: number; lines: { variantId: string; quantity: number }[] } | { ok: false; result: ReserveResult }

/** The request checked and normalised: one line per variant, in id order so locks never deadlock. */
function reserveLines(input: ReserveInput): ReserveLines {
  const ttl = input.ttlSeconds ?? RESERVATION_TTL.defaultSeconds
  if (!Number.isInteger(ttl) || ttl < RESERVATION_TTL.minSeconds || ttl > RESERVATION_TTL.maxSeconds) return { ok: false, result: { ok: false, reason: "invalid", detail: "ttl out of range" } }
  const merged = new Map<string, number>()
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 99) return { ok: false, result: { ok: false, reason: "invalid", detail: "quantity" } }
    merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity)
  }
  if (merged.size === 0 || merged.size > 50) return { ok: false, result: { ok: false, reason: "invalid", detail: "lines" } }
  // Lock order by id, so two multi-line reservations can never wait on each other (no deadlock).
  return { ok: true, ttl, lines: [...merged].map(([variantId, quantity]) => ({ variantId, quantity })).sort((a, b) => a.variantId.localeCompare(b.variantId)) }
}

/**
 * The reservation itself, inside the caller's transaction (Stage 13.04: placing an order holds its
 * stock in the same transaction, so the order and its hold commit together or not at all). The same
 * checks and ledger movements as reserveStock. Not enough stock throws InsufficientStockError, which
 * rolls the caller's whole transaction back; every other refusal is returned.
 */
export async function reserveWithin(tx: Tx, input: ReserveInput): Promise<ReserveResult> {
  const checked = reserveLines(input)
  if (!checked.ok) return checked.result
  const { ttl, lines } = checked
  const earlier = await tx.inventoryReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { lines: true } })
  if (earlier) {
    const same = earlier.orderId === input.orderId && earlier.lines.length === lines.length && lines.every(l => earlier.lines.some(e => e.variantId === l.variantId && e.quantity === l.quantity))
    return same ? { ok: true as const, reservationId: earlier.id, expiresAt: earlier.expiresAt, replayed: true } : { ok: false as const, reason: "key_reused" as const, detail: "the key was used for a different reservation" }
  }
  const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { status: true } })
  if (order?.status !== "pending_payment") return { ok: false as const, reason: "order_not_pending" as const, detail: order ? order.status : "missing" }

  const sellable = await tx.productVariant.findMany({
    where: { id: { in: lines.map(l => l.variantId) }, archivedAt: null, product: { status: "active" }, balance: { lastCountedAt: { not: null } } },
    select: { id: true },
  })
  const notSellable = lines.filter(l => !sellable.some(s => s.id === l.variantId)).map(l => l.variantId)
  if (notSellable.length) return { ok: false as const, reason: "not_sellable" as const, variantIds: notSellable }

  const expiresAt = new Date(Date.now() + ttl * 1000)
  const reservation = await tx.inventoryReservation.create({ data: { orderId: input.orderId, expiresAt, idempotencyKey: input.idempotencyKey, lines: { create: lines } } })
  for (const l of lines) {
    await applyMovement(tx, { variantId: l.variantId, type: "reservation", quantity: l.quantity, reason: "held for checkout", reasonCode: "reservation", actor: { kind: "system", id: null }, reference: { type: "reservation", id: reservation.id }, idempotencyKey: `reserve:${reservation.id}:${l.variantId}` })
  }
  return { ok: true as const, reservationId: reservation.id, expiresAt, replayed: false }
}

/** Holds every line or none. The same idempotency key returns the same reservation. */
export async function reserveStock(db: Db, input: ReserveInput): Promise<ReserveResult> {
  const checked = reserveLines(input)
  if (!checked.ok) return checked.result
  try {
    return await db.$transaction(tx => reserveWithin(tx, input), { maxWait: 10_000, timeout: 15_000 })
  } catch (error) {
    if (error instanceof InsufficientStockError) return { ok: false, reason: "out_of_stock", variantIds: [error.variantId] }
    // A concurrent request with the same key (or for the same order) committed first.
    if (isDuplicateKey(error)) {
      const winner = await db.inventoryReservation.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (winner && winner.orderId === input.orderId) return { ok: true, reservationId: winner.id, expiresAt: winner.expiresAt, replayed: true }
      return { ok: false, reason: "key_reused", detail: "the order already has a reservation" }
    }
    throw error
  }
}

export type TransitionOutcome = "applied" | "noop" | "rejected"

/** Moves a reservation once: compare-and-set on its status, then one ledger movement per line. */
export async function transitionReservation(tx: Tx, reservationId: string, to: "allocated" | "released", facts: GuardFacts, why: string, correlationId: string): Promise<TransitionOutcome> {
  const reservation = await tx.inventoryReservation.findUnique({ where: { id: reservationId }, include: { lines: true } })
  if (!reservation) return "rejected"
  const plan = planTransition(RESERVATION_MACHINE, reservation.status as ReservationStatus, to, facts)
  if (plan.kind === "noop") return "noop"
  if (plan.kind === "rejected") return "rejected"
  await declareOrigin(tx, { actor: { kind: "system", id: null }, correlationId, reason: plan.precondition })
  const { count } = await tx.inventoryReservation.updateMany({ where: { id: reservationId, status: reservation.status }, data: { status: to } })
  if (count !== 1) return "noop" // someone else moved it first
  const type = to === "allocated" ? "allocation" : "release"
  for (const l of reservation.lines) {
    await applyMovement(tx, { variantId: l.variantId, type, quantity: l.quantity, reason: why, reasonCode: plan.precondition, actor: { kind: "system", id: null }, reference: { type: "reservation", id: reservationId }, idempotencyKey: `${type}:${reservationId}:${l.variantId}` })
  }
  await recordAdminEvent(tx, { action: "reservation.transition", actor: SYSTEM, entity: { type: "reservation", id: reservationId }, reason: plan.precondition, before: { status: reservation.status }, after: { status: to }, correlationId })
  return "applied"
}

/** What the reservation's order and payment say right now. */
export async function factsFor(tx: Tx, reservationId: string, now = new Date()) {
  const r = await tx.inventoryReservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: { order: { select: { id: true, status: true, grandTotalPaise: true, currency: true, payments: { orderBy: { createdAt: "desc" }, select: { status: true, capturedAmountPaise: true, currency: true } } } } },
  })
  // A captured attempt speaks for the order even when a newer attempt was opened after it (Stage 13.11).
  const payment = r.order.payments.find(p => p.status === "captured") ?? r.order.payments[0]
  const facts: GuardFacts = {
    source: "system",
    orderStatus: r.order.status,
    paymentStatus: payment?.status as PaymentStatus | undefined,
    reservationStatus: r.status as ReservationStatus,
    amountMatches: payment ? payment.capturedAmountPaise === r.order.grandTotalPaise && payment.currency === r.order.currency : false,
    reservationExpired: r.expiresAt <= now,
  }
  return { reservation: r, facts }
}

export type ExpiryOutcome = "allocated" | "released" | "held_for_payment" | "needs_review" | "noop"

/**
 * Decides one expired (or due) reservation, in the caller's transaction:
 *   captured for the full amount  -> allocate (a late success keeps its stock)
 *   payment authorized/reconciling -> keep holding for PAYMENT_GRACE_MS past expiry, then release
 *   anything else                  -> release
 */
export async function settleReservation(tx: Tx, reservationId: string, correlationId: string, now = new Date()): Promise<ExpiryOutcome> {
  const { reservation, facts } = await factsFor(tx, reservationId, now)
  if (reservation.status !== "active") return "noop"
  if (facts.paymentStatus === "captured") {
    if (facts.amountMatches) return (await transitionReservation(tx, reservationId, "allocated", facts, "payment captured", correlationId)) === "applied" ? "allocated" : "noop"
    // Captured but for the wrong amount: never release stock under a paid order; staff decide.
    await toReview(tx, reservation.orderId, facts, correlationId)
    return "needs_review"
  }
  const inFlight = facts.paymentStatus === "authorized" || facts.paymentStatus === "pending_reconciliation"
  if (inFlight && now.getTime() < reservation.expiresAt.getTime() + PAYMENT_GRACE_MS) return "held_for_payment"
  if (!facts.reservationExpired && facts.orderStatus !== "cancelled" && facts.paymentStatus !== "failed" && facts.paymentStatus !== "expired") return "noop"
  const why = inFlight ? "payment still pending after the grace period" : "hold expired or payment closed"
  // The machine's guard needs an expired hold or a closed payment; an in-flight payment past the grace period counts as expired.
  return (await transitionReservation(tx, reservationId, "released", { ...facts, reservationExpired: true }, why, correlationId)) === "applied" ? "released" : "noop"
}

async function toReview(tx: Tx, orderId: string, facts: GuardFacts, correlationId: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })
  if (order.status !== "pending_payment") return
  await transitionOrder(tx, { orderId, from: "pending_payment", to: "needs_review", facts: { ...facts, amountMatches: false }, actor: { kind: "system", id: null }, correlationId })
}

/**
 * A capture that arrives after the hold was released (payments call this, Stage 14). The stock may
 * have been sold to someone else, so nothing is re-reserved automatically: the order goes to
 * needs_review for staff to allocate stock by hand or refund. Safe to call more than once.
 */
export async function handleLateCapture(db: Db, orderId: string, correlationId: string): Promise<"allocated" | "needs_review" | "noop"> {
  return db.$transaction(async tx => {
    const reservation = await tx.inventoryReservation.findUnique({ where: { orderId }, select: { id: true } })
    if (!reservation) return "noop"
    const { reservation: r, facts } = await factsFor(tx, reservation.id)
    if (facts.paymentStatus !== "captured") return "noop"
    if (r.status === "active") {
      const outcome = await settleReservation(tx, r.id, correlationId)
      return outcome === "allocated" ? "allocated" : outcome === "needs_review" ? "needs_review" : "noop"
    }
    if (r.status === "released") {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })
      if (order.status !== "pending_payment") return "noop"
      await transitionOrder(tx, { orderId, from: "pending_payment", to: "needs_review", facts, actor: { kind: "system", id: null }, correlationId })
      return "needs_review"
    }
    return "noop"
  })
}

/** Releases a reservation because its order was cancelled. */
export function releaseForCancelledOrder(db: Db, reservationId: string, correlationId: string) {
  return db.$transaction(async tx => {
    const { facts } = await factsFor(tx, reservationId)
    if (facts.paymentStatus === "captured") return "rejected" as const
    return transitionReservation(tx, reservationId, "released", { ...facts, orderStatus: "cancelled" }, "order cancelled", correlationId)
  })
}
