import type { Actor, ContractVersion, IdempotencyKey, IsoDateTime, OrderId, ReservationId, Result, Sku } from "./common.ts"
import type { ReservationStatus } from "./state-machines.ts"

// Inventory module. Authority: Chaanavya database (a movement ledger plus balances).
// available = onHand - reserved - allocated, and must never go negative (invariants.ts).
// There is no back-ordering in the first release.

export type InventoryBalanceV1 = {
  version: ContractVersion
  sku: Sku
  onHand: number
  reserved: number
  allocated: number
}

export type MovementType = "receipt" | "correction" | "reservation" | "release" | "allocation" | "fulfilment" | "return" | "write_off"

/** Immutable ledger row. Corrections are new rows, never edits. */
export type InventoryMovementV1 = {
  version: ContractVersion
  id: string
  sku: Sku
  type: MovementType
  /** Signed change to the bucket the type affects. */
  quantity: number
  reason: string
  actor: Actor
  reference: { kind: "order" | "reservation" | "return" | "adjustment"; id: string }
  occurredAt: IsoDateTime
}

export type ReservationV1 = {
  version: ContractVersion
  id: ReservationId
  orderId: OrderId
  status: ReservationStatus
  lines: { sku: Sku; quantity: number }[]
  expiresAt: IsoDateTime
}

export interface InventoryService {
  getBalances(skus: Sku[]): Promise<InventoryBalanceV1[]>
  /** All lines or nothing; the same key returns the same reservation (Stage 08). */
  reserve(orderId: OrderId, lines: { sku: Sku; quantity: number }[], ttlSeconds: number, key: IdempotencyKey): Promise<Result<ReservationV1>>
  /** Moves a reservation through RESERVATION_MACHINE; each move happens exactly once. */
  transition(reservationId: ReservationId, to: ReservationStatus, actor: Actor, key: IdempotencyKey): Promise<Result<ReservationV1>>
  /** Staff adjustments need a reason code and the stock permission. */
  recordMovement(movement: Omit<InventoryMovementV1, "id" | "occurredAt" | "version">, key: IdempotencyKey): Promise<Result<InventoryMovementV1>>
}
