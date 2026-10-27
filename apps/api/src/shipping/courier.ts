// Which courier answers, and delivery and rates for the shopper's bag (Stage 12.08).
//
// Choice     production uses a live courier only, and none is connected yet, so production answers
//            mode "none": no rates and nothing deliverable. Development and staging use the sandbox
//            courier (mode "test"). The sandbox is never chosen in production, whatever is configured.
// Test/live  a test answer is shown for what it is, a simulation: its rates are test rates, its
//            delivery answer has source "test" and never sets `deliverable`, and `liveEligible` is
//            false. Only a live courier's serviceable answer with an accepted quote makes a bag
//            eligible to ship. A live answer carrying a sandbox service is not trusted.
// Bag        the shopper's own current bag and its saved contact address (12.04). Weights, prices and
//            restrictions come from the catalogue on the server; the browser sends nothing but its
//            session. Read only: nothing is reserved, booked or stored.
import { resolveEnvironment } from "@chaanavya/shared/config/env"
import type { CourierGateway, RateQuoteV1, ShippingRatesV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import type { IsoDateTime, Shopper } from "@chaanavya/contracts/modules/common"
import type { IndianAddressV1 } from "@chaanavya/contracts/modules/checkout"
import { ApiError } from "../admin/api.ts"
import { findCurrentCart } from "../cart/ownership.ts"
import { deliveryCheck } from "../checkout/region.ts"
import type { Db } from "../db/client.ts"
import { parcelFor, quoteParcel, rateRequest, QUOTE_TIMEOUT_MS } from "./rates.ts"
import { isSandboxServiceRef, SANDBOX_PICKUP_PIN, sandboxCourier } from "./sandbox-courier.ts"

type Env = Readonly<Record<string, string | undefined>>
export type CourierChoice = { gateway: CourierGateway; pickupPinCode: string } | null

/** The courier for this environment. `live` is a connected courier, when one exists (none does yet). */
export function courierFor(env: Env, live: CourierChoice = null): CourierChoice {
  if (resolveEnvironment(env) === "production") return live && live.gateway.mode === "live" && live.gateway.provider !== "sandbox" ? live : null
  return live ?? { gateway: sandboxCourier(), pickupPinCode: SANDBOX_PICKUP_PIN }
}

const modeOf = (choice: CourierChoice): ShippingRatesV1["mode"] => (!choice ? "none" : choice.gateway.mode === "live" && choice.gateway.provider !== "sandbox" ? "live" : "test")

const unavailable = (reason: "parcel_unsupported" | "provider_unavailable", now: Date): RateQuoteV1 => ({ status: "unavailable", reason, options: [], quotedAt: now.toISOString() as IsoDateTime })

async function serviceability(gateway: CourierGateway, input: Parameters<CourierGateway["checkServiceability"]>[0]) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([gateway.checkServiceability(input), new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), QUOTE_TIMEOUT_MS)))])
    if (!answer || typeof answer.serviceable !== "boolean" || !["ok", "pin_unserviceable", "category_restricted", "provider_unavailable"].includes(answer.reason)) return { serviceable: false, codAvailable: false, reason: "provider_unavailable" as const }
    return answer
  } catch {
    return { serviceable: false, codAvailable: false, reason: "provider_unavailable" as const }
  } finally {
    clearTimeout(timer)
  }
}

/** Delivery and rates for the shopper's bag to its saved contact address. */
export async function shippingRatesFor(db: Db, owner: Shopper | null, choice: CourierChoice, now = new Date()): Promise<ShippingRatesV1> {
  if (!owner) throw new ApiError(404, "not_found", "not found")
  const cart = await findCurrentCart(db, owner, now)
  if (!cart) throw new ApiError(404, "not_found", "not found")
  const lines = await db.cartLine.findMany({
    where: { cartId: cart.id },
    orderBy: { createdAt: "asc" },
    select: { quantity: true, variant: { select: { sku: true, weightGrams: true, pricePaise: true, product: { select: { title: true, shippingRestriction: true } } } } },
  })
  if (lines.length === 0) throw new ApiError(409, "conflict", "your bag is empty")
  const contact = await db.cartContact.findUnique({ where: { cartId: cart.id }, select: { shippingAddress: true } })
  if (!contact) throw new ApiError(409, "conflict", "add a delivery address first", { shippingAddress: "required" })
  const address = contact.shippingAddress as unknown as IndianAddressV1

  const mode = modeOf(choice)
  if (!choice || mode === "none") return { mode: "none", delivery: deliveryCheck(address.pinCode), quote: null, liveEligible: false, restrictedItems: [] }
  const source = mode === "live" ? "live" : "test"

  const built = parcelFor(lines.map(l => ({ sku: l.variant.sku, quantity: l.quantity, weightGrams: l.variant.weightGrams, unitPricePaise: l.variant.pricePaise, restriction: l.variant.product.shippingRestriction })))
  const weightGrams = built.ok ? built.parcel.weightGrams : 0
  const categories = built.ok ? built.parcel.restrictions : []
  const delivery = deliveryCheck(address.pinCode, await serviceability(choice.gateway, { pickupPinCode: choice.pickupPinCode, deliveryPinCode: address.pinCode, weightGrams, categories }), source)

  const request = built.ok ? rateRequest(choice.pickupPinCode, address, built.parcel) : null
  let quote = request ? await quoteParcel(choice.gateway, request, { now: () => now }) : unavailable("parcel_unsupported", now)
  // A live courier never offers a sandbox service: if one appears, the whole answer is not trusted.
  if (mode === "live" && quote.status === "available" && quote.options.some(o => isSandboxServiceRef(o.serviceRef))) quote = unavailable("provider_unavailable", now)
  // Rates only for an address the courier serves.
  if (delivery.delivery !== "serviceable" && quote.status === "available") quote = { status: "unavailable", reason: delivery.delivery === "not_serviceable" ? "pin_unserviceable" : "provider_unavailable", options: [], quotedAt: now.toISOString() as IsoDateTime }

  // Name the items whose restriction no offered service carries, in bag order, once each.
  const notCarried = quote.status === "unavailable" && quote.reason === "category_restricted" ? (quote.notCarried ?? []) : []
  const restrictedItems = lines
    .filter(l => l.variant.product.shippingRestriction !== null && (notCarried as string[]).includes(l.variant.product.shippingRestriction))
    .map(l => ({ sku: l.variant.sku, title: l.variant.product.title }))
    .filter((item, i, all) => all.findIndex(x => x.sku === item.sku) === i)
  return { mode, delivery, quote, liveEligible: mode === "live" && delivery.deliverable && quote.status === "available", restrictedItems }
}
