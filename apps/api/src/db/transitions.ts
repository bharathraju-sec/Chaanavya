// Transaction-safe status transitions (Stage 04). Pattern for every state machine:
//   1. decide with planTransition (lib/modules/contracts/state-machines.ts),
//   2. compare-and-set: update the row only if it is still in the expected state,
//   3. write the audit event in the same transaction.
// Call inside db().$transaction(async tx => ...), so the status and its audit row commit or roll
// back together. Shown for orders; payments, reservations and shipments follow the same shape.
import type { Tx } from "./client.ts"
import type { ActorKind } from "./generated/enums.ts"
import { ORDER_MACHINE, planTransition, type GuardFacts, type OrderStatus } from "@chaanavya/contracts/modules/state-machines"

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

export type OrderTransitionInput = {
  orderId: string
  from: OrderStatus
  to: OrderStatus
  facts: GuardFacts
  actor: { kind: ActorKind; id: string | null }
  correlationId: string
}

export async function transitionOrder(tx: Tx, input: OrderTransitionInput): Promise<"applied" | "noop"> {
  const plan = planTransition(ORDER_MACHINE, input.from, input.to, input.facts)
  if (plan.kind === "noop") return "noop"
  if (plan.kind === "rejected") throw new TransitionRejectedError(plan.reason, plan.precondition)

  const { count } = await tx.order.updateMany({ where: { id: input.orderId, status: input.from }, data: { status: input.to } })
  if (count !== 1) throw new ConcurrentUpdateError(`order is no longer ${input.from}`)

  await tx.auditEvent.create({
    data: {
      action: "order.transition",
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      entityType: "order",
      entityId: input.orderId,
      reason: plan.precondition,
      before: { status: input.from },
      after: { status: input.to },
      correlationId: input.correlationId,
    },
  })
  return "applied"
}
