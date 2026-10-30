// The origin of a sensitive change (Stage 13.08). Before an order, fulfilment, payment or stock-hold
// status changes, the writing transaction declares who asked for it and which request it came from; the
// database records it in the order event trail (migration 20261029020000_order_events) and refuses any
// such change made without one. Transaction-local: it ends with the transaction and never leaks into
// another request on the same connection. Never carries personal data: an actor kind and id (a
// customer's or staff member's account id, a provider's name, or null for a guest or a job), the
// correlation id and the rule met.
import type { Tx } from "./client.ts"
import type { ActorKind } from "./generated/enums.ts"

export type Origin = { actor: { kind: ActorKind; id: string | null }; correlationId: string; reason?: string }

export async function declareOrigin(tx: Tx, origin: Origin) {
  const value = JSON.stringify({ actorKind: origin.actor.kind, actorId: origin.actor.id, correlationId: origin.correlationId, reason: origin.reason ?? "" })
  await tx.$queryRaw`SELECT set_config('chaanavya.origin', ${value}, true)`
}
