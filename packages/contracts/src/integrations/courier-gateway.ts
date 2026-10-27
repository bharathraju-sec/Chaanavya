import type { CourierProviderName, IdempotencyKey, IsoDateTime } from "../modules/common.ts"
import type { DeliveryCheckV1, IndianAddressV1 } from "../modules/checkout.ts"
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

/**
 * How couriers must handle what is in a parcel (Stage 08 product field). "none" is never sent: a parcel
 * lists only the restrictions that apply to something in it.
 */
export type ShippingRestrictionV1 = "fragrance_liquid" | "jewellery_high_value"

/** One parcel to quote for (Stage 12.07): built on the server from catalogue weights and restrictions. */
export type RateParcelV1 = {
  weightGrams: number
  /** Packed size, when known; null means the courier rates on weight alone. */
  dimensionsMm: { length: number; width: number; height: number } | null
  /** What the goods are worth, for insurance and courier value limits. */
  declaredValuePaise: number
  restrictions: ShippingRestrictionV1[]
  items: { sku: string; quantity: number }[]
}

export type RateRequestV1 = {
  pickupPinCode: string
  deliveryPinCode: string
  deliveryStateCode: string
  parcel: RateParcelV1
  /** Cash on delivery is not offered (no payment decision yet), so every quote is for a prepaid parcel. */
  paymentMode: "prepaid"
}

/** A courier's offer for one parcel, with the limits it was offered under. */
export type CourierRateOptionV1 = CourierServiceOptionV1 & {
  mode: "air" | "surface"
  maxWeightGrams: number
  /** Highest declared value the service carries; null when the courier sets none. */
  maxDeclaredValuePaise: number | null
  /** Restrictions the service accepts; a parcel with any other restriction cannot use it. */
  acceptsRestrictions: ShippingRestrictionV1[]
}

export type RateUnavailableReason = "pin_unserviceable" | "category_restricted" | "parcel_unsupported" | "provider_unavailable"

/**
 * A rate quote. Either at least one offer the courier actually made for this exact parcel, or none and
 * the reason: an unavailable quote never carries an option, and nothing here is ever a made-up fee.
 */
export type RateQuoteV1 =
  | { status: "available"; options: CourierRateOptionV1[]; quotedAt: IsoDateTime }
  | {
      status: "unavailable"
      reason: RateUnavailableReason
      options: []
      quotedAt: IsoDateTime
      /**
       * With reason "category_restricted", when the server could tell: the parcel's restrictions that
       * no offered service carries. Empty when each is carried by some service, never all by one.
       */
      notCarried?: ShippingRestrictionV1[]
    }

/**
 * Delivery and rates for the shopper's bag (Stage 12.08). `mode` says where the answer came from:
 * "test" is the sandbox courier, whose prices and delivery answers are simulated and must be shown as
 * test rates; "live" is a connected courier; "none" means no courier is connected here. Only a live
 * answer can make a bag eligible to ship (`liveEligible`); a test answer never does.
 */
export type ShippingRatesV1 = {
  mode: "test" | "live" | "none"
  delivery: DeliveryCheckV1
  quote: RateQuoteV1 | null
  liveEligible: boolean
  /** The bag's items no offered service carries (12.12 follow-up), so the shopper can be told which; empty otherwise. */
  restrictedItems: { sku: string; title: string }[]
}

export interface CourierGateway {
  /** "sandbox" is the simulated courier for development (apps/api/src/shipping/sandbox-courier.ts); it is always mode "test". */
  readonly provider: CourierProviderName | "sandbox"
  readonly mode: "test" | "live"
  checkServiceability(input: { pickupPinCode: string; deliveryPinCode: string; weightGrams: number; categories: string[] }): Promise<ServiceabilityV1>
  getRates(input: { pickupPinCode: string; deliveryPinCode: string; parcels: ParcelV1[] }): Promise<CourierServiceOptionV1[]>
  /** Offers for one parcel to one address (Stage 12.07). The server checks every answer (apps/api/src/shipping/rates.ts). */
  quoteRates(input: RateRequestV1): Promise<RateQuoteV1>
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
