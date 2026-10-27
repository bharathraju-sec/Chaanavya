// Courier rates for a parcel (Stage 12.07). Two pure steps around any courier gateway:
//
// Parcel   built on the server from catalogue data: every line needs a weight and a reviewed shipping
//          restriction, or the parcel is unsupported. Nothing is guessed: no default weight, no
//          default box, no packaging allowance until the owner sets one. The declared value is what the
//          goods cost; restrictions are the product's own (fragrance_liquid, jewellery_high_value).
// Offers   only what the courier itself returned, for this exact parcel. Each offer is checked: a
//          well-formed whole-paise INR rate, a weight limit at or above the parcel, a declared-value
//          limit at or above the goods, and acceptance of every restriction in the parcel. Anything else
//          is dropped. No offer left means "unavailable" with a reason and an empty list. An error, a
//          timeout or a malformed answer is provider_unavailable. A fee is never made up, defaulted or
//          carried over from another parcel or address.
import type { CourierGateway, CourierRateOptionV1, RateParcelV1, RateQuoteV1, RateRequestV1, RateUnavailableReason, ShippingRestrictionV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import type { IsoDateTime } from "@chaanavya/contracts/modules/common"
import { isPinCode, stateCodeOf } from "../checkout/region.ts"

export const RESTRICTIONS: readonly ShippingRestrictionV1[] = ["fragrance_liquid", "jewellery_high_value"]
export const QUOTE_TIMEOUT_MS = 5000

export type ParcelLine = {
  sku: string
  quantity: number
  /** Catalogue weight of one unit; null when nobody has entered it. */
  weightGrams: number | null
  unitPricePaise: bigint
  /** The product's reviewed restriction; null when nobody has reviewed it. */
  restriction: "none" | ShippingRestrictionV1 | null
}

export type ParcelProblem = { sku: string; problem: "weight_missing" | "restriction_unreviewed" | "invalid_line" }

/** The parcel for these lines, or the lines that stop one being built. */
export function parcelFor(lines: readonly ParcelLine[]): { ok: true; parcel: RateParcelV1 } | { ok: false; problems: ParcelProblem[] } {
  const problems: ParcelProblem[] = []
  if (lines.length === 0) return { ok: false, problems: [{ sku: "", problem: "invalid_line" }] }
  let weight = 0
  let value = 0n
  const restrictions = new Set<ShippingRestrictionV1>()
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || typeof line.unitPricePaise !== "bigint" || line.unitPricePaise < 0n) {
      problems.push({ sku: line.sku, problem: "invalid_line" })
      continue
    }
    if (line.weightGrams === null || !Number.isSafeInteger(line.weightGrams) || line.weightGrams <= 0) problems.push({ sku: line.sku, problem: "weight_missing" })
    else weight += line.weightGrams * line.quantity
    if (line.restriction === null || !(line.restriction === "none" || RESTRICTIONS.includes(line.restriction))) problems.push({ sku: line.sku, problem: "restriction_unreviewed" })
    else if (line.restriction !== "none") restrictions.add(line.restriction)
    value += line.unitPricePaise * BigInt(line.quantity)
  }
  if (problems.length > 0) return { ok: false, problems }
  if (!Number.isSafeInteger(weight) || value > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, problems: [{ sku: "", problem: "invalid_line" }] }
  return {
    ok: true,
    parcel: {
      weightGrams: weight,
      dimensionsMm: null,
      declaredValuePaise: Number(value),
      restrictions: RESTRICTIONS.filter(r => restrictions.has(r)),
      items: lines.map(l => ({ sku: l.sku, quantity: l.quantity })),
    },
  }
}

const isPaise = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const isText = (v: unknown, max = 120): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max

/** Whether this offer, exactly as the courier gave it, can carry this parcel. */
function fits(option: unknown, parcel: RateParcelV1): option is CourierRateOptionV1 {
  if (typeof option !== "object" || option === null) return false
  const o = option as Record<string, unknown>
  const rate = o.rate as Record<string, unknown> | null | undefined
  if (!isText(o.serviceRef) || !isText(o.courierName)) return false
  if (!rate || rate.currency !== "INR" || !isPaise(rate.amountPaise)) return false
  if (o.mode !== "air" && o.mode !== "surface") return false
  if (!isPaise(o.maxWeightGrams) || o.maxWeightGrams < parcel.weightGrams) return false
  if (o.maxDeclaredValuePaise !== null && (!isPaise(o.maxDeclaredValuePaise) || o.maxDeclaredValuePaise < parcel.declaredValuePaise)) return false
  if (!Array.isArray(o.acceptsRestrictions) || !parcel.restrictions.every(r => (o.acceptsRestrictions as unknown[]).includes(r))) return false
  if (o.estimatedDeliveryDays !== null && !(Number.isSafeInteger(o.estimatedDeliveryDays) && (o.estimatedDeliveryDays as number) >= 0 && (o.estimatedDeliveryDays as number) <= 60)) return false
  return typeof o.quotedAt === "string" && !Number.isNaN(Date.parse(o.quotedAt))
}

/** Whether an offer turns this parcel away because it does not accept one of the parcel's restrictions. */
function blocks(option: unknown, parcel: RateParcelV1) {
  if (typeof option !== "object" || option === null) return false
  const accepts = (option as Record<string, unknown>).acceptsRestrictions
  return Array.isArray(accepts) && !parcel.restrictions.every(r => accepts.includes(r))
}

const unavailable = (reason: RateUnavailableReason, now: Date): RateQuoteV1 => ({ status: "unavailable", reason, options: [], quotedAt: now.toISOString() as IsoDateTime })

/** The parcel's restrictions that no offer with a readable list of accepted restrictions carries. */
function notCarriedBy(offered: unknown[], parcel: RateParcelV1): ShippingRestrictionV1[] {
  const accepted = (o: unknown) => (typeof o === "object" && o !== null && Array.isArray((o as Record<string, unknown>).acceptsRestrictions) ? ((o as Record<string, unknown>).acceptsRestrictions as unknown[]) : null)
  return parcel.restrictions.filter(r => !offered.some(o => accepted(o)?.includes(r)))
}

/**
 * Checks a courier's answer for this request and keeps only offers that fit the parcel, cheapest
 * first (ties by service reference, so the order is stable). The courier's own unavailable answer is
 * kept as it is, without options.
 */
export function acceptQuote(request: RateRequestV1, answer: unknown, now = new Date()): RateQuoteV1 {
  if (typeof answer !== "object" || answer === null) return unavailable("provider_unavailable", now)
  const a = answer as Record<string, unknown>
  if (a.status === "unavailable") {
    const reason = a.reason
    const known: RateUnavailableReason[] = ["pin_unserviceable", "category_restricted", "parcel_unsupported", "provider_unavailable"]
    return unavailable(known.includes(reason as RateUnavailableReason) ? (reason as RateUnavailableReason) : "provider_unavailable", now)
  }
  if (a.status !== "available" || !Array.isArray(a.options)) return unavailable("provider_unavailable", now)
  const offered = a.options as unknown[]
  const options = offered.filter((o): o is CourierRateOptionV1 => fits(o, request.parcel))
  if (options.length === 0) {
    // Every offer was refused because none carries a restricted item: say so; otherwise the parcel is unsupported.
    const restricted = request.parcel.restrictions.length > 0 && offered.length > 0 && offered.every(o => blocks(o, request.parcel))
    if (restricted) return { ...unavailable("category_restricted", now), notCarried: notCarriedBy(offered, request.parcel) } as RateQuoteV1
    return unavailable("parcel_unsupported", now)
  }
  const copy = options
    .map(o => ({ serviceRef: o.serviceRef, courierName: o.courierName, rate: { amountPaise: o.rate.amountPaise, currency: o.rate.currency }, estimatedDeliveryDays: o.estimatedDeliveryDays, quotedAt: o.quotedAt, mode: o.mode, maxWeightGrams: o.maxWeightGrams, maxDeclaredValuePaise: o.maxDeclaredValuePaise, acceptsRestrictions: [...o.acceptsRestrictions] }))
    .sort((x, y) => x.rate.amountPaise - y.rate.amountPaise || (x.serviceRef < y.serviceRef ? -1 : x.serviceRef > y.serviceRef ? 1 : 0))
  return { status: "available", options: copy, quotedAt: now.toISOString() as IsoDateTime }
}

/** A rate request from the pickup PIN, the delivery address and a built parcel; null when an address part is malformed. */
export function rateRequest(pickupPinCode: string, delivery: { pinCode: string; stateCode: string }, parcel: RateParcelV1): RateRequestV1 | null {
  const state = stateCodeOf(delivery.stateCode)
  if (!isPinCode(pickupPinCode) || !isPinCode(delivery.pinCode) || !state) return null
  return { pickupPinCode, deliveryPinCode: delivery.pinCode, deliveryStateCode: state, parcel, paymentMode: "prepaid" }
}

/** Asks the courier and checks the answer. A throw, a timeout or a malformed answer is provider_unavailable. */
export async function quoteParcel(gateway: Pick<CourierGateway, "quoteRates">, request: RateRequestV1, { timeoutMs = QUOTE_TIMEOUT_MS, now = () => new Date() } = {}): Promise<RateQuoteV1> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([gateway.quoteRates(request), new Promise<"timeout">(resolve => (timer = setTimeout(() => resolve("timeout"), timeoutMs)))])
    if (answer === "timeout") return unavailable("provider_unavailable", now())
    return acceptQuote(request, answer, now())
  } catch {
    return unavailable("provider_unavailable", now())
  } finally {
    clearTimeout(timer)
  }
}
