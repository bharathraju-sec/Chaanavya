// Canonical audit events for sensitive admin actions (Stage 06; catalogue actions since Stage 08). Each action has fixed rules:
// which entity it concerns, whether staff must give a reason, and which before/after fields must
// be present. recordAdminEvent refuses an event that breaks its rule, so a mutation cannot commit
// with an incomplete trail (call it inside the same transaction as the change).
//
// The actor always comes from the server session (or a named system process), never from a
// request body. Values are redacted summaries: IDs, amounts, roles, codes; no personal data.
import type { Db, Tx } from "../db/client.ts"
import type { AuditAction } from "@chaanavya/contracts/modules/audit"

export type AdminAuditAction = Extract<
  AuditAction,
  | "price.changed"
  | "product.created"
  | "product.updated"
  | "product.status_changed"
  | "product.variants_saved"
  | "collection.created"
  | "collection.updated"
  | "media.uploaded"
  | "media.updated"
  | "media.approved"
  | "media.rejected"
  | "media.removed"
  | "catalogue.imported"
  | "inventory.received"
  | "inventory.written_off"
  | "inventory.settings_changed"
  | "inventory.discrepancy"
  | "stocktake.created"
  | "stocktake.submitted"
  | "stocktake.approved"
  | "stocktake.cancelled"
  | "reservation.transition"
  | "inventory.adjusted"
  | "refund.approved"
  | "staff.created"
  | "staff.role_granted"
  | "staff.role_revoked"
  | "staff.deactivated"
  | "staff.sessions_revoked"
  | "shipment.booked"
  | "shipment.cancelled"
  | "settings.changed"
  | "tax_profile.created"
  | "tax_profile.updated"
  | "tax_profile.approved"
  | "tax_profile.activated"
  | "customer.contact_viewed"
  | "order.held"
  | "order.released"
  | "order.note_added"
  | "order.recovery_case_opened"
  | "order.recovery_case_cleared"
  | "order.recovery_case_resolved"
>

type Rule = { entity: string; reason: boolean; before?: readonly string[]; after?: readonly string[] }

export const ADMIN_AUDIT_RULES: Readonly<Record<AdminAuditAction, Rule>> = {
  "price.changed": { entity: "product_variant", reason: true, before: ["pricePaise"], after: ["pricePaise"] },
  // Catalogue (Stage 08). Draft edits need no reason; anything that changes what shoppers see does.
  "product.created": { entity: "product", reason: false, after: ["handle", "status"] },
  "product.updated": { entity: "product", reason: false, after: ["fields", "live"] },
  "product.status_changed": { entity: "product", reason: true, before: ["status"], after: ["status"] },
  "product.variants_saved": { entity: "product", reason: false, after: ["created", "updated", "archived"] },
  "collection.created": { entity: "collection", reason: false, after: ["handle"] },
  "collection.updated": { entity: "collection", reason: false, after: ["fields"] },
  "media.uploaded": { entity: "product_media", reason: false, after: ["productId", "byteSize", "contentType"] },
  "media.updated": { entity: "product_media", reason: false, after: ["fields"] },
  "media.approved": { entity: "product_media", reason: false, after: ["productId"] },
  "media.rejected": { entity: "product_media", reason: true, after: ["productId"] },
  "media.removed": { entity: "product_media", reason: false, before: ["status"], after: ["productId"] },
  "catalogue.imported": { entity: "catalogue_import", reason: true, after: ["productsCreated", "productsUpdated", "variants"] },
  "inventory.adjusted": { entity: "product_variant", reason: true, after: ["delta", "reasonCode"] },
  // Inventory (Stage 09). Every stock change is also an immutable ledger row in the same transaction.
  "inventory.received": { entity: "product_variant", reason: true, after: ["quantity", "onHand"] },
  "inventory.written_off": { entity: "product_variant", reason: true, after: ["quantity", "reasonCode"] },
  "inventory.settings_changed": { entity: "product_variant", reason: false, after: ["lowStockThreshold"] },
  "inventory.discrepancy": { entity: "product_variant", reason: false, after: ["problem"] },
  "stocktake.created": { entity: "stocktake", reason: false, after: ["source"] },
  "stocktake.submitted": { entity: "stocktake", reason: false, after: ["lines"] },
  "stocktake.approved": { entity: "stocktake", reason: true, after: ["lines", "corrections", "signedName"] },
  "stocktake.cancelled": { entity: "stocktake", reason: true },
  "reservation.transition": { entity: "reservation", reason: false, before: ["status"], after: ["status"] },
  "refund.approved": { entity: "refund", reason: true, after: ["amountPaise"] },
  "staff.created": { entity: "user", reason: true, after: ["role"] },
  "staff.role_granted": { entity: "user", reason: true, after: ["role"] },
  "staff.role_revoked": { entity: "user", reason: true, before: ["role"] },
  "staff.deactivated": { entity: "user", reason: true, after: ["sessionsRevoked"] },
  "staff.sessions_revoked": { entity: "user", reason: true, after: ["sessionsRevoked"] },
  "shipment.booked": { entity: "shipment", reason: false, after: ["courier"] },
  "shipment.cancelled": { entity: "shipment", reason: true },
  "settings.changed": { entity: "setting", reason: true, before: ["value"], after: ["value"] },
  // GST configuration (Stage 12.05): drafts need no reason; approving and activating do.
  "tax_profile.created": { entity: "tax_profile", reason: false, after: ["sellerStateCode", "rates"] },
  "tax_profile.updated": { entity: "tax_profile", reason: false, after: ["sellerStateCode", "rates"] },
  "tax_profile.approved": { entity: "tax_profile", reason: true, after: ["signedName", "advisorReference", "rates"] },
  "tax_profile.activated": { entity: "tax_profile", reason: true, before: ["activeProfileId"], after: ["activeProfileId"] },
  // Orders (Stage 13.12): every read of a buyer's full contact details is on record.
  "customer.contact_viewed": { entity: "order", reason: false, after: ["fields"] },
  // Staff order actions (Stage 13.13): a hold or release needs a reason; a note is recorded by id and length, never its text.
  "order.held": { entity: "order", reason: true, before: ["held"], after: ["held"] },
  "order.released": { entity: "order", reason: true, before: ["held"], after: ["held"] },
  "order.note_added": { entity: "order", reason: false, after: ["noteId", "length"] },
  // Order recovery (Stage 13.14): the reconciliation job opens and clears cases; staff resolve them with a reason.
  "order.recovery_case_opened": { entity: "order_recovery_case", reason: false, after: ["orderId", "kind"] },
  "order.recovery_case_cleared": { entity: "order_recovery_case", reason: false, after: ["orderId", "kind"] },
  "order.recovery_case_resolved": { entity: "order_recovery_case", reason: true, before: ["status"], after: ["status"] },
}

export type AdminActor = { kind: "staff"; id: string } | { kind: "system"; process: string }

type Snapshot = Record<string, string | number | boolean | null>

export type AdminAuditEvent = {
  action: AdminAuditAction
  actor: AdminActor
  entity: { type: string; id: string }
  reason: string
  correlationId: string
  before?: Snapshot
  after?: Snapshot
}

export class AuditRuleError extends Error {}

/** Checks an event against its rule. Exported for tests; recordAdminEvent always calls it. */
export function validateAdminEvent(event: AdminAuditEvent) {
  const rule = ADMIN_AUDIT_RULES[event.action]
  if (!rule) throw new AuditRuleError(`unknown audit action ${event.action}`)
  if (event.entity.type !== rule.entity) throw new AuditRuleError(`${event.action} must reference a ${rule.entity}`)
  if (!event.entity.id) throw new AuditRuleError(`${event.action} needs an entity id`)
  if (!event.correlationId) throw new AuditRuleError(`${event.action} needs a correlation id`)
  if (rule.reason && event.reason.trim().length < 3) throw new AuditRuleError(`${event.action} needs a reason`)
  for (const key of rule.before ?? []) if (!(key in (event.before ?? {}))) throw new AuditRuleError(`${event.action} needs before.${key}`)
  for (const key of rule.after ?? []) if (!(key in (event.after ?? {}))) throw new AuditRuleError(`${event.action} needs after.${key}`)
  if (event.actor.kind === "staff" && !event.actor.id) throw new AuditRuleError("staff actor needs an id")
}

export async function recordAdminEvent(db: Db | Tx, event: AdminAuditEvent) {
  validateAdminEvent(event)
  return db.auditEvent.create({
    data: {
      action: event.action,
      actorKind: event.actor.kind,
      actorId: event.actor.kind === "staff" ? event.actor.id : `system:${event.actor.process}`,
      entityType: event.entity.type,
      entityId: event.entity.id,
      reason: event.reason.trim() || event.action,
      before: event.before,
      after: event.after,
      correlationId: event.correlationId,
    },
  })
}
