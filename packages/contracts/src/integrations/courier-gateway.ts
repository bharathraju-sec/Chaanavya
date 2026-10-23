import type { CourierProviderName, IdempotencyKey, IsoDateTime } from "../modules/common.ts"
import type { IndianAddressV1 } from "../modules/checkout.ts"
import type { MoneyPaise } from "../modules/money.ts"
import type { ParcelV1, TrackingEventV1 } from "../modules/shipment.ts"

// Port for courier aggregators (Shiprocket first). Only the shipment and checkout modules call
// it, on the server. Courier partners only: no Chaanavya delivery agents. Interface only.

export type CourierServiceOptionV1 = {
  serviceRef: string
  courierName: string
  rate: MoneyPaise
  estimatedDeliveryDays: number | null
  /** Where the price and estimate came from, shown to staff when choosing (Stage 16). */
  quotedAt: IsoDateTime
}

export type ServiceabilityV1 = { serviceable: boolean; codAvailable: boolean; reason: "ok" | "pin_unserviceable" | "category_restricted" | "provider_unavailable" }

export interface CourierGateway {
  readonly provider: CourierProviderName
  readonly mode: "test" | "live"
  checkServiceability(input: { pickupPinCode: string; deliveryPinCode: string; weightGrams: number; categories: string[] }): Promise<ServiceabilityV1>
  getRates(input: { pickupPinCode: string; deliveryPinCode: string; parcels: ParcelV1[] }): Promise<CourierServiceOptionV1[]>
  /** The same key must not create a second courier order. */
  createShipment(input: { orderNumber: string; pickupLocationRef: string; deliveryAddress: IndianAddressV1; parcels: ParcelV1[]; key: IdempotencyKey }): Promise<{ providerShipmentId: string }>
  assignCourier(input: { providerShipmentId: string; serviceRef: string }): Promise<{ awb: string; courierName: string }>
  schedulePickup(input: { providerShipmentId: string }): Promise<{ pickupDate: IsoDateTime | null }>
  getLabel(input: { providerShipmentId: string }): Promise<{ labelPdfUrl: string }>
  cancelShipment(input: { providerShipmentId: string; awb: string | null }): Promise<{ cancelled: boolean }>
  track(input: { awb: string }): Promise<TrackingEventV1[]>
  createReversePickup(input: { orderNumber: string; pickupAddress: IndianAddressV1; parcels: ParcelV1[]; key: IdempotencyKey }): Promise<{ providerShipmentId: string }>
  validateWebhook(input: { rawBody: string; headers: Record<string, string> }): Promise<{ valid: false } | { valid: true; awb: string; event: TrackingEventV1 }>
}
