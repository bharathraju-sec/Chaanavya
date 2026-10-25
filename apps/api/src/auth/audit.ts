// Identity and access audit events (Stage 05): sign-ins, sign-outs, two-factor, denials, claims.
// Staff administration (roles, deactivation, session revocation) uses the canonical admin catalogue
// in lib/modules/audit/catalogue.ts. Written to the append-only audit_event table.
// Never include codes, passwords, tokens or full email addresses.
import type { Db, Tx } from "../db/client.ts"
import type { ActorKind } from "../db/generated/enums.ts"

export type IdentityAction =
  | "identity.user_created"
  | "identity.signed_in"
  | "identity.signed_out"
  | "identity.two_factor_enabled"
  | "identity.two_factor_disabled"
  | "identity.password_reset"
  | "identity.access_denied"
  | "order.claimed"
  | "cart.merged"

export type IdentityEvent = {
  action: IdentityAction
  actor: { kind: ActorKind; id: string | null }
  entity: { type: string; id: string }
  reason: string
  correlationId: string
  after?: Record<string, string | number | boolean | null>
}

export async function recordIdentityEvent(db: Db | Tx, event: IdentityEvent) {
  await db.auditEvent.create({
    data: {
      action: event.action,
      actorKind: event.actor.kind,
      actorId: event.actor.id,
      entityType: event.entity.type,
      entityId: event.entity.id,
      reason: event.reason,
      after: event.after ?? undefined,
      correlationId: event.correlationId,
    },
  })
}
