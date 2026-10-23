import type { Actor, ContractVersion, CourierProviderName, IdempotencyKey, IsoDateTime, OrderId, Result, ShipmentId, Sku } from "./common.ts"
import type { MoneyPaise } from "./money.ts"
import type { ShipmentStatus } from "./state-machines.ts"

// Shipment module. Authority for where a parcel is: the courier's scans. Courier partners only;
// there are no Chaanavya delivery agents, logins or GPS tracking.

export type ParcelV1 = { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number; items: { sku: Sku; quantity: number }[] }

export type TrackingEventV1 = {
  /** Courier event ID, or a hash of (AWB, status code, timestamp) when the courier gives none. */
  eventId: string
  status: ShipmentStatus
  courierStatusCode: string
  location: string | null
  occurredAt: IsoDateTime
}

export type ShipmentV1 = {
  version: ContractVersion
  id: ShipmentId
  orderId: OrderId
  provider: CourierProviderName
  courierName: string | null
  awb: string | null
  status: ShipmentStatus
  parcels: ParcelV1[]
  shippingCost: MoneyPaise | null
  trackingUrl: string | null
  events: TrackingEventV1[]
  createdAt: IsoDateTime
}

export interface ShipmentService {
  /** One booking per key: a retried submission never creates a second AWB (S16-002). */
  book(orderId: OrderId, parcels: ParcelV1[], courierServiceRef: string, actor: Actor, key: IdempotencyKey): Promise<Result<ShipmentV1>>
  cancel(shipmentId: ShipmentId, actor: Actor, reason: string, key: IdempotencyKey): Promise<Result<ShipmentV1>>
  /** Appends a verified tracking event once and moves the status through SHIPMENT_MACHINE. */
  recordTrackingEvent(shipmentId: ShipmentId, event: TrackingEventV1): Promise<Result<{ outcome: "applied" | "duplicate" | "ignored" }>>
}
