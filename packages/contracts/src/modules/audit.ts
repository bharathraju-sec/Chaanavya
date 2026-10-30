import type { Actor, AuditEventId, ContractVersion, CorrelationId, IsoDateTime } from "./common.ts"

// Audit module: append-only record of sensitive actions (Stage 06). Values are redacted: no card
// data, provider signatures, tokens, full cart IDs or full addresses.

export type AuditAction =
  | "order.transition"
  | "order.fulfilment_transition"
  | "payment.event"
  | "payment.transition"
  | "payment.late_capture"
  | "customer.contact_viewed"
  | "order.held"
  | "order.released"
  | "order.note_added"
  | "order.recovery_case_opened"
  | "order.recovery_case_cleared"
  | "order.recovery_case_resolved"
  | "refund.requested"
  | "refund.transition"
  | "inventory.adjusted"
  | "reservation.transition"
  | "price.changed"
  | "product.status_changed"
  | "product.created"
  | "product.updated"
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
  | "shipment.booked"
  | "shipment.cancelled"
  | "return.transition"
  | "staff.created"
  | "staff.role_granted"
  | "staff.role_revoked"
  | "staff.deactivated"
  | "staff.sessions_revoked"
  | "refund.approved"
  | "settings.changed"
  | "tax_profile.created"
  | "tax_profile.updated"
  | "tax_profile.approved"
  | "tax_profile.activated"

export type AuditEventV1 = {
  version: ContractVersion
  id: AuditEventId
  action: AuditAction
  actor: Actor
  entity: { type: string; id: string }
  /** Transition precondition ID or staff reason code. */
  reason: string
  /** Redacted summaries of the changed fields. */
  before: Record<string, string | number | boolean | null> | null
  after: Record<string, string | number | boolean | null> | null
  correlationId: CorrelationId
  occurredAt: IsoDateTime
}

export interface AuditLog {
  /** Written in the same transaction as the change it describes. Never updated or deleted. */
  record(event: Omit<AuditEventV1, "id" | "version">): Promise<AuditEventV1>
}
