// Transaction-safe status transitions (Stage 04; actors and fulfilment, Stage 13.06; payments, and
// payment kept apart from fulfilment, Stage 13.07). Pattern for every state machine:
//   1. lock the row and read its current state; facts the row holds (order status, fulfilment status,
//      and since Stage 13.11 the order's stock hold) come from the database, never from the caller,
//   2. check the actor may ask for this move (ORDER_, FULFILMENT_, PAYMENT_TRANSITION_ACTORS) and bind
//      the guard's fact source to the actor, so nobody can claim to be a provider or staff. A payment
//      provider and a courier are different actors: a payment callback can never move fulfilment, so a
//      paid order is never shipped by its payment alone,
//   3. decide with planTransition (packages/contracts/src/modules/state-machines.ts),
//   4. compare-and-set: update the row only if it is still in the expected state,
//   5. write the audit event in the same transaction.
// Call inside db().$transaction(async tx => ...), so the status and its audit row commit or roll back
// together. The database refuses any move that is not a transition of its machine (migration
// 20261029000000_order_transitions, 20261029010000_payment_transitions), whoever writes it.
import type { Tx } from "./client.ts"
import { declareOrigin } from "./origin.ts"
import type { ActorKind } from "./generated/enums.ts"
import {
  actorClassOf,
  actorMayTransition,
  FULFILMENT_MACHINE,
  FULFILMENT_TRANSITION_ACTORS,
  ORDER_MACHINE,
  ORDER_TRANSITION_ACTORS,
  PAYMENT_MACHINE,
  PAYMENT_TRANSITION_ACTORS,
  planTransition,
  sourceOf,
  type FulfilmentStatus,
  type GuardFacts,
  type OrderStatus,
  type PaymentStatus,
  type ReservationStatus,
} from "@chaanavya/contracts/modules/state-machines"

export class TransitionRejectedError extends Error {
  readonly reason: string
  readonly precondition: string | undefined
  constructor(reason: string, precondition?: string) {
    super(precondition ? `transition rejected: ${reason} (${precondition})` : `transition rejected: ${reason}`)
    this.reason = reason
    this.precondition = precondition
  }
}

/** Another request changed the row first; reload and decide again. */
export class ConcurrentUpdateError extends Error {}

type Actor = { kind: ActorKind; id: string | null }

export type OrderTransitionInput = {
  orderId: string
  from: OrderStatus
  to: OrderStatus
  facts: GuardFacts
  actor: Actor
  correlationId: string
}

export type FulfilmentTransitionInput = {
  orderId: string
  from: FulfilmentStatus
  to: FulfilmentStatus
  facts: GuardFacts
  actor: Actor
  correlationId: string
}

/** The order row, locked for this transaction: its own statuses are facts the caller cannot override. */
async function lockOrder(tx: Tx, orderId: string) {
  const [row] = await tx.$queryRaw<{ status: OrderStatus; fulfilment_status: FulfilmentStatus; held_at: Date | null }[]>`SELECT status, fulfilment_status, held_at FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`
  if (!row) throw new TransitionRejectedError("unknown_order")
  return row
}

const bound = (facts: GuardFacts, actor: Actor, row: { status: OrderStatus; fulfilment_status: FulfilmentStatus }): GuardFacts => ({
  ...facts,
  source: sourceOf(actorClassOf(actor)!),
  orderStatus: row.status,
  fulfilmentStatus: row.fulfilment_status,
})

async function audit(tx: Tx, action: string, input: { orderId: string; actor: Actor; correlationId: string }, precondition: string, before: object, after: object) {
  await tx.auditEvent.create({
    data: { action, actorKind: input.actor.kind, actorId: input.actor.id, entityType: "order", entityId: input.orderId, reason: precondition, before, after, correlationId: input.correlationId },
  })
}

export async function transitionOrder(tx: Tx, input: OrderTransitionInput): Promise<"applied" | "noop"> {
  const row = await lockOrder(tx, input.orderId)
  if (row.status === input.to) return "noop"
  if (row.status !== input.from) throw new ConcurrentUpdateError(`order is no longer ${input.from}`)
  if (!actorMayTransition(ORDER_TRANSITION_ACTORS, input.from, input.to, actorClassOf(input.actor))) {
    throw new TransitionRejectedError(ORDER_MACHINE.transitions.some(t => t.from === input.from && t.to === input.to) ? "actor_not_allowed" : "not_allowed")
  }
  // The order's stock hold, when it has one, speaks for itself (Stage 13.11): no caller can confirm an
  // order by claiming stock is allocated when its hold was released.
  const hold = await tx.inventoryReservation.findUnique({ where: { orderId: input.orderId }, select: { status: true } })
  const facts = hold ? { ...input.facts, reservationStatus: hold.status as ReservationStatus } : input.facts
  const plan = planTransition(ORDER_MACHINE, input.from, input.to, bound(facts, input.actor, row))
  if (plan.kind === "noop") return "noop"
  if (plan.kind === "rejected") throw new TransitionRejectedError(plan.reason, plan.precondition)

  await declareOrigin(tx, { actor: input.actor, correlationId: input.correlationId, reason: plan.precondition })
  const { count } = await tx.order.updateMany({ where: { id: input.orderId, status: input.from }, data: { status: input.to } })
  if (count !== 1) throw new ConcurrentUpdateError(`order is no longer ${input.from}`)
  await audit(tx, "order.transition", input, plan.precondition, { status: input.from }, { status: input.to })
  return "applied"
}

/** Moves an order's fulfilment one step: packing, packed, handed over to the courier, or cancelled. */
export async function transitionFulfilment(tx: Tx, input: FulfilmentTransitionInput): Promise<"applied" | "noop"> {
  const row = await lockOrder(tx, input.orderId)
  if (row.fulfilment_status === input.to) return "noop"
  if (row.fulfilment_status !== input.from) throw new ConcurrentUpdateError(`fulfilment is no longer ${input.from}`)
  // A staff hold (Stage 13.13) stops fulfilment moving forward; cancelling stays possible. The database refuses it too.
  if (row.held_at && input.to !== "cancelled") throw new TransitionRejectedError("order_on_hold")
  if (!actorMayTransition(FULFILMENT_TRANSITION_ACTORS, input.from, input.to, actorClassOf(input.actor))) {
    throw new TransitionRejectedError(FULFILMENT_MACHINE.transitions.some(t => t.from === input.from && t.to === input.to) ? "actor_not_allowed" : "not_allowed")
  }
  const plan = planTransition(FULFILMENT_MACHINE, input.from, input.to, bound(input.facts, input.actor, row))
  if (plan.kind === "noop") return "noop"
  if (plan.kind === "rejected") throw new TransitionRejectedError(plan.reason, plan.precondition)

  await declareOrigin(tx, { actor: input.actor, correlationId: input.correlationId, reason: plan.precondition })
  const { count } = await tx.order.updateMany({ where: { id: input.orderId, fulfilmentStatus: input.from }, data: { fulfilmentStatus: input.to } })
  if (count !== 1) throw new ConcurrentUpdateError(`fulfilment is no longer ${input.from}`)
  await audit(tx, "order.fulfilment_transition", input, plan.precondition, { fulfilmentStatus: input.from }, { fulfilmentStatus: input.to })
  return "applied"
}

export type PaymentTransitionInput = {
  paymentAttemptId: string
  from: PaymentStatus
  to: PaymentStatus
  facts: GuardFacts
  actor: Actor
  correlationId: string
}

/**
 * Moves one payment attempt (Stage 13.07): only on a verified event from the attempt's own payment
 * provider, or a system job where the payment machine allows it. Touches the payment attempt alone:
 * the order's status follows through transitionOrder, and fulfilment never follows a payment.
 */
export async function transitionPayment(tx: Tx, input: PaymentTransitionInput): Promise<"applied" | "noop"> {
  const [row] = await tx.$queryRaw<{ status: PaymentStatus; provider: string; order_id: string }[]>`SELECT status, provider::text AS provider, order_id FROM "payment_attempt" WHERE id = ${input.paymentAttemptId}::uuid FOR UPDATE`
  if (!row) throw new TransitionRejectedError("unknown_payment")
  if (row.status === input.to) return "noop"
  if (row.status !== input.from) throw new ConcurrentUpdateError(`payment is no longer ${input.from}`)
  const actorClass = actorClassOf(input.actor)
  if (!actorMayTransition(PAYMENT_TRANSITION_ACTORS, input.from, input.to, actorClass)) {
    throw new TransitionRejectedError(PAYMENT_MACHINE.transitions.some(t => t.from === input.from && t.to === input.to) ? "actor_not_allowed" : "not_allowed")
  }
  // One provider's event never moves another provider's payment.
  if (actorClass === "payment_provider" && input.actor.id !== row.provider) throw new TransitionRejectedError("provider_mismatch")
  const plan = planTransition(PAYMENT_MACHINE, input.from, input.to, { ...input.facts, source: sourceOf(actorClass!), paymentStatus: row.status })
  if (plan.kind === "noop") return "noop"
  if (plan.kind === "rejected") throw new TransitionRejectedError(plan.reason, plan.precondition)

  await declareOrigin(tx, { actor: input.actor, correlationId: input.correlationId, reason: plan.precondition })
  const { count } = await tx.paymentAttempt.updateMany({ where: { id: input.paymentAttemptId, status: input.from }, data: { status: input.to } })
  if (count !== 1) throw new ConcurrentUpdateError(`payment is no longer ${input.from}`)
  await tx.auditEvent.create({
    data: { action: "payment.transition", actorKind: input.actor.kind, actorId: input.actor.id, entityType: "payment_attempt", entityId: input.paymentAttemptId, reason: plan.precondition, before: { status: input.from }, after: { status: input.to, orderId: row.order_id }, correlationId: input.correlationId },
  })
  return "applied"
}
