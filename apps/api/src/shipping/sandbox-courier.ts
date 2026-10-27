// The sandbox courier (Stage 12.08): a simulated courier for development and staging, so delivery and
// rates can be built and tested before a courier account exists. It is always mode "test", never
// used in production (see courierFor in ./courier.ts), and every price it gives is a test rate that
// the shop must label as one. Nothing here is a real courier price, service or delivery promise.
//
// Deterministic: the same request always gets the same answer. No randomness, no network, no clock
// except the quote time passed in.
//
// Delivery  a delivery PIN ending in 999 is not serviceable; one ending in 998 simulates a courier
//           outage (provider_unavailable). Every other well-formed PIN is serviceable.
// Zones     from the synthetic pickup PIN 560001: the same first two digits is local, the same first
//           digit is regional, anything else is national.
// Services  surface: up to 20 kg, carries fragrance_liquid. Air: up to 5 kg, carries no restricted
//           item. Both carry goods worth up to Rs 50,000. Nothing carries jewellery_high_value, so a
//           jewellery parcel is category_restricted.
// Prices    per 500 g slab (part slabs count as whole): a zone base for the first slab, then a fixed
//           amount per extra slab. The answer still goes through acceptQuote like any courier's.
import type { CourierGateway, CourierRateOptionV1, RateQuoteV1, RateRequestV1, ServiceabilityV1, ShippingRestrictionV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import type { IsoDateTime } from "@chaanavya/contracts/modules/common"
import { isPinCode } from "../checkout/region.ts"

/** The sandbox's own pickup PIN. Synthetic: not the shop's pickup address, which is not decided. */
export const SANDBOX_PICKUP_PIN = "560001"
export const SANDBOX_SERVICE_PREFIX = "sandbox:"
const SLAB_GRAMS = 500

type Zone = "local" | "regional" | "national"
type Service = { key: "surface" | "air"; courierName: string; maxWeightGrams: number; accepts: ShippingRestrictionV1[]; base: Record<Zone, number>; perSlab: number; days: Record<Zone, number> }

const SERVICES: readonly Service[] = [
  { key: "surface", courierName: "Sandbox Surface", maxWeightGrams: 20000, accepts: ["fragrance_liquid"], base: { local: 3000, regional: 4500, national: 6000 }, perSlab: 2000, days: { local: 2, regional: 4, national: 6 } },
  { key: "air", courierName: "Sandbox Air", maxWeightGrams: 5000, accepts: [], base: { local: 5000, regional: 7000, national: 9000 }, perSlab: 4000, days: { local: 1, regional: 2, national: 3 } },
]
const MAX_DECLARED_VALUE_PAISE = 5_000_000

export function sandboxZone(pickupPinCode: string, deliveryPinCode: string): Zone {
  if (pickupPinCode.slice(0, 2) === deliveryPinCode.slice(0, 2)) return "local"
  if (pickupPinCode[0] === deliveryPinCode[0]) return "regional"
  return "national"
}

function serviceability(deliveryPinCode: string): ServiceabilityV1 {
  if (!isPinCode(deliveryPinCode) || deliveryPinCode.endsWith("999")) return { serviceable: false, codAvailable: false, reason: "pin_unserviceable" }
  if (deliveryPinCode.endsWith("998")) return { serviceable: false, codAvailable: false, reason: "provider_unavailable" }
  return { serviceable: true, codAvailable: false, reason: "ok" }
}

const notSimulated = (what: string) => async (): Promise<never> => {
  throw new Error(`the sandbox courier does not ${what}; it only answers delivery and rates`)
}

/** A sandbox courier. `now` gives the quote time; tests pass a fixed clock. */
export function sandboxCourier({ now = () => new Date() }: { now?: () => Date } = {}): CourierGateway {
  return {
    provider: "sandbox",
    mode: "test",
    async checkServiceability(input) {
      return serviceability(input.deliveryPinCode)
    },
    async quoteRates(input: RateRequestV1): Promise<RateQuoteV1> {
      const quotedAt = now().toISOString() as IsoDateTime
      const check = serviceability(input.deliveryPinCode)
      if (!check.serviceable) return { status: "unavailable", reason: check.reason === "provider_unavailable" ? "provider_unavailable" : "pin_unserviceable", options: [], quotedAt }
      const zone = sandboxZone(input.pickupPinCode, input.deliveryPinCode)
      const slabs = Math.max(1, Math.ceil(input.parcel.weightGrams / SLAB_GRAMS))
      const options: CourierRateOptionV1[] = SERVICES.map(s => ({
        serviceRef: `${SANDBOX_SERVICE_PREFIX}${s.key}`,
        courierName: s.courierName,
        rate: { amountPaise: s.base[zone] + s.perSlab * (slabs - 1), currency: "INR" },
        estimatedDeliveryDays: s.days[zone],
        quotedAt,
        mode: s.key,
        maxWeightGrams: s.maxWeightGrams,
        maxDeclaredValuePaise: MAX_DECLARED_VALUE_PAISE,
        acceptsRestrictions: [...s.accepts],
      }))
      // Every service is offered with its limits, as a real aggregator answers; acceptQuote drops the ones that cannot carry the parcel.
      return { status: "available", options, quotedAt }
    },
    getRates: notSimulated("give legacy rates"),
    createShipment: notSimulated("create shipments"),
    assignCourier: notSimulated("assign couriers"),
    schedulePickup: notSimulated("schedule pickups"),
    getLabel: notSimulated("print labels"),
    cancelShipment: notSimulated("cancel shipments"),
    track: notSimulated("track parcels"),
    createReversePickup: notSimulated("book returns"),
    validateWebhook: async () => ({ valid: false }),
  }
}

export const isSandboxServiceRef = (serviceRef: string) => serviceRef.startsWith(SANDBOX_SERVICE_PREFIX)
