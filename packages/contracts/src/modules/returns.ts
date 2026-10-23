import type { Actor, ContractVersion, IdempotencyKey, IsoDateTime, OrderId, RefundId, Result, ReturnId, ShipmentId, Sku } from "./common.ts"
import type { ReturnStatus } from "./state-machines.ts"

// Returns module: customer-initiated returns only. Return to origin (RTO) is a shipment outcome
// (rto_initiated / rto_delivered) and is never recorded as a customer return (S17-004).
// Return window, eligible categories and reasons are business terms awaiting owner approval.

export type ReturnItemV1 = {
  sku: Sku
  quantity: number
  /** Set at inspection. Restocking is a separate inventory movement, never automatic. */
  restockable: boolean | null
}

export type ReturnRequestV1 = {
  version: ContractVersion
  id: ReturnId
  orderId: OrderId
  items: ReturnItemV1[]
  reason: string
  status: ReturnStatus
  /** Customer-visible explanation; internal notes are kept elsewhere and never shown. */
  customerMessage: string | null
  reversePickupShipmentId: ShipmentId | null
  refundId: RefundId | null
  requestedAt: IsoDateTime
}

export interface ReturnService {
  request(actor: Actor, orderId: OrderId, items: { sku: Sku; quantity: number }[], reason: string, key: IdempotencyKey): Promise<Result<ReturnRequestV1>>
  /** Moves the request through RETURN_MACHINE with the actor's permission checked server-side. */
  transition(actor: Actor, returnId: ReturnId, to: ReturnStatus, reason: string, key: IdempotencyKey): Promise<Result<ReturnRequestV1>>
}
