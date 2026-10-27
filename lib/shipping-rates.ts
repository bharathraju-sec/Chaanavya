// What the bag shows for delivery and courier rates (Stage 12.08), from the API's ShippingRatesV1.
// Presentation only: the API decides the rates and whether a bag can ship.
//
// Test rates come from the sandbox courier in development and staging. They are simulated, so every
// one is labelled a test rate, the block says plainly that they are not real delivery prices, and no
// test answer is ever worded as a delivery promise. The label follows the API's `mode` alone: a test
// answer is shown as a test even if other fields look live. Live rates are shown without any of this.
import type { ShippingRatesV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import { formatMoney } from "@/lib/types"

export type ShippingRow = { key: string; label: string; detail: string | null; price: string; testRate: boolean }
export type ShippingDisplay =
  | { kind: "hidden" }
  | { kind: "test" | "live"; heading: string; badge: string | null; notice: string | null; delivery: string; rows: ShippingRow[]; unavailable: string | null }

export const TEST_BADGE = "Test rates"
export const TEST_NOTICE = "These come from a sandbox courier used for testing. They are not real delivery prices, and nothing can be shipped at them."

const UNAVAILABLE: Record<string, string> = {
  pin_unserviceable: "No delivery option to this PIN code.",
  category_restricted: "Something in your bag cannot be sent by the available delivery options.",
  parcel_unsupported: "We can't price delivery for this bag yet.",
  provider_unavailable: "Delivery options could not be loaded. Try again shortly.",
}

const days = (n: number | null) => (n === null ? null : n === 1 ? "about 1 day" : `about ${n} days`)

function deliveryLine(rates: ShippingRatesV1, test: boolean) {
  const { pinCode, delivery } = rates.delivery
  if (test) {
    if (delivery === "serviceable") return `Simulated: the sandbox courier delivers to ${pinCode}.`
    if (delivery === "not_serviceable") return `Simulated: the sandbox courier does not deliver to ${pinCode}.`
    return `Simulated: no sandbox answer for ${pinCode}.`
  }
  if (rates.delivery.deliverable) return `Delivers to ${pinCode}.`
  if (delivery === "not_serviceable") return `We don't deliver to ${pinCode} yet.`
  return `Delivery to ${pinCode} is not confirmed yet.`
}

export function describeShipping(rates: ShippingRatesV1 | null | undefined): ShippingDisplay {
  if (!rates || rates.mode === "none") return { kind: "hidden" }
  const test = rates.mode !== "live"
  const options = rates.quote?.status === "available" ? rates.quote.options : []
  const rows = options.map(o => ({
    key: o.serviceRef,
    label: o.courierName,
    detail: days(o.estimatedDeliveryDays),
    price: formatMoney(o.rate.amountPaise / 100),
    testRate: test,
  }))
  const reason = rates.quote && rates.quote.status === "unavailable" ? rates.quote.reason : rates.quote ? null : "provider_unavailable"
  return {
    kind: test ? "test" : "live",
    heading: test ? "Delivery (test rates)" : "Delivery",
    badge: test ? TEST_BADGE : null,
    notice: test ? TEST_NOTICE : null,
    delivery: deliveryLine(rates, test),
    rows,
    unavailable: rows.length === 0 ? (UNAVAILABLE[reason ?? ""] ?? UNAVAILABLE.provider_unavailable) : null,
  }
}
