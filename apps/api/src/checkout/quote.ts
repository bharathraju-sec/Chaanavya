// The checkout quote (Stage 12.09): the shopper's bag priced on the server, start to finish.
//
// Inputs    the shopper's own current bag. Prices are the live catalogue's (readCart), the discount is
//           the applied promotion checked again now, delivery is the courier's own offer for this
//           bag and saved address (12.07, 12.08), and GST comes from the tax profile (12.05, 12.06).
//           The request body may name a delivery option (`serviceRef`) and the bag revision the
//           shopper looked at (`cartRevision`). Nothing else in it is read: a price, discount, fee,
//           tax or total sent by the browser has no effect on the quote.
// Delivery  the shopper picks one of the courier's offers by reference; with no pick, the cheapest
//           (owner decision, 27 October 2026). The fee is the courier's quoted price: no markup or
//           free-delivery rule yet. GST on it is shared across the lines by value (compute.ts).
// Refused   no bag 404; empty bag, unavailable or under-stocked items, no delivery address, no
//           delivery offer or no usable tax profile 409; a stale revision 409; an offer that was not
//           made 400.
// Test      a quote priced with sandbox delivery rates or an unapproved tax profile is mode "test"
//           and says why; such a quote can never become a real order.
// Stored    the latest quote per bag, replaced each time (one row), written under the bag's row lock
//           and only if the bag has not changed since it was priced. It expires after 15 minutes.
//           Moves no money, reserves no stock and places no order.
// Bound     (Stage 12.10) to its owner, its bag and what it was priced from (./quote-fingerprint.ts);
//           checkQuote refuses it once it has expired or anything it was priced from has changed.
import { randomUUID } from "node:crypto"
import { resolveEnvironment } from "@chaanavya/shared/config/env"
import type { CartId, IsoDateTime, PromotionId, QuoteId, Shopper, Sku, VariantId } from "@chaanavya/contracts/modules/common"
import type { CheckoutQuoteV1, IndianAddressV1 } from "@chaanavya/contracts/modules/checkout"
import type { MoneyPaise, TaxLineV1 } from "@chaanavya/contracts/modules/money"
import { ApiError } from "../admin/api.ts"
import { readCart } from "../cart/cart.ts"
import type { Db } from "../db/client.ts"
import { toPaise } from "../db/money.ts"
import { courierFor, shippingRatesFor, type CourierChoice } from "../shipping/courier.ts"
import type { TaxedComponent } from "../tax/compute.ts"
import { taxForBag } from "../tax/profile.ts"
import { FINGERPRINT_PARTS, FINGERPRINT_VERSION, fingerprintOf, ownerHashOf, safeEqual } from "./quote-fingerprint.ts"

export const QUOTE_LIFETIME_MS = 15 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Env = Readonly<Record<string, string | undefined>>

/** The only fields a quote request may carry. Anything else (amounts included) is ignored. */
export function parseQuoteRequest(body: Record<string, unknown>): { serviceRef: string | null; cartRevision: number | null } {
  const { serviceRef, cartRevision } = body
  const problems: Record<string, string> = {}
  if (serviceRef !== undefined && serviceRef !== null && (typeof serviceRef !== "string" || serviceRef.length === 0 || serviceRef.length > 120)) problems.serviceRef = "invalid"
  if (cartRevision !== undefined && cartRevision !== null && (typeof cartRevision !== "number" || !Number.isSafeInteger(cartRevision) || cartRevision < 0)) problems.cartRevision = "invalid"
  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "check the highlighted fields", problems)
  return { serviceRef: (serviceRef as string | null | undefined) ?? null, cartRevision: (cartRevision as number | null | undefined) ?? null }
}

const inr = (paise: bigint | number): MoneyPaise => ({ amountPaise: typeof paise === "bigint" ? toPaise(paise) : paise, currency: "INR" })
const taxLines = (tax: TaxedComponent[]): TaxLineV1[] => tax.map(c => ({ component: c.component, rateBasisPoints: c.rateBasisPoints, amount: inr(c.amountPaise) }))
const conflict = (message: string, fields?: Record<string, string>) => new ApiError(409, "conflict", message, fields)

export type QuoteOptions = { env?: Env; courier?: CourierChoice; now?: Date }

/**
 * Prices the shopper's bag without storing anything: for a new quote, and to check a stored one.
 * `courier` and the environment default to this process's.
 */
async function priceBag(
  db: Db,
  owner: Shopper,
  request: { serviceRef: string | null; cartRevision: number | null },
  { env = process.env, courier, now = new Date() }: QuoteOptions,
): Promise<{ quote: CheckoutQuoteV1; address: { pinCode: string; stateCode: string } }> {
  const cart = await readCart(db, owner, now)
  if (!cart) throw new ApiError(404, "not_found", "not found")
  if (cart.lines.length === 0) throw conflict("your bag is empty")
  if (request.cartRevision !== null && request.cartRevision !== cart.revision) throw conflict("your bag changed; review it again", { cartRevision: "stale" })
  if (cart.issues.length > 0) throw conflict("remove the items that are no longer available", Object.fromEntries(cart.issues.map(i => [`lines.${i.lineId}`, "unavailable"])))

  // Tax category and stock, read now. A line needs counted stock and enough units available.
  const variants = await db.productVariant.findMany({
    where: { id: { in: cart.lines.map(l => l.variantId) } },
    select: { id: true, sku: true, taxCategory: true, balance: { select: { onHand: true, reserved: true, allocated: true, lastCountedAt: true } } },
  })
  const byId = new Map(variants.map(v => [v.id, v]))
  const short: Record<string, string> = {}
  for (const line of cart.lines) {
    const stock = byId.get(line.variantId)?.balance
    if (!stock || stock.lastCountedAt === null || stock.onHand - stock.reserved - stock.allocated < line.quantity) short[`lines.${line.id}`] = "insufficient_stock"
  }
  if (Object.keys(short).length > 0) throw conflict("some items do not have enough stock", short)

  const contact = await db.cartContact.findUnique({ where: { cartId: cart.id }, select: { shippingAddress: true } })
  if (!contact) throw conflict("add a delivery address first", { shippingAddress: "required" })
  const address = contact.shippingAddress as unknown as IndianAddressV1

  // Delivery: only an offer the courier made for this bag and address.
  const rates = await shippingRatesFor(db, owner, courier === undefined ? courierFor(env) : courier, now)
  if (rates.mode === "none" || !rates.quote) throw conflict("delivery is not available yet", { shipping: "no_courier" })
  if (rates.quote.status !== "available") throw conflict("no delivery option for this bag and address", { shipping: rates.quote.reason })
  const option = request.serviceRef === null ? rates.quote.options[0]! : rates.quote.options.find(o => o.serviceRef === request.serviceRef)
  if (!option) throw new ApiError(400, "invalid_request", "choose one of the delivery options offered", { serviceRef: "not_offered" })

  const tax = await taxForBag(db, resolveEnvironment(env), {
    lines: cart.lines.map(l => ({ key: l.id, taxCategory: byId.get(l.variantId)!.taxCategory, unitPricePaise: BigInt(l.unitPrice.amountPaise), quantity: l.quantity })),
    discountPaise: BigInt(cart.discount.amountPaise),
    deliveryStateCode: address.stateCode,
    shippingFeePaise: BigInt(option.rate.amountPaise),
  })
  const first = tax.lines[0]!.classification
  const taxTotal = tax.taxPaise + tax.shipping.taxPaise
  const grandTotal = tax.totalPaise + tax.shipping.totalPaise
  // The total must add up from its parts; anything else is a bug, never a price.
  const expected = tax.subtotalPaise - tax.discountPaise + tax.shipping.feePaise + (first.pricesIncludeTax ? 0n : taxTotal)
  if (grandTotal !== expected) throw new Error("checkout quote does not add up")

  const testReasons: CheckoutQuoteV1["testReasons"] = []
  if (rates.mode !== "live") testReasons.push("test_shipping_rates")
  if (!first.profileApproved) testReasons.push("tax_profile_unapproved")
  const expiresAt = new Date(now.getTime() + QUOTE_LIFETIME_MS)
  const promotionId = cart.promotion?.applied ? ((await db.cart.findUnique({ where: { id: cart.id }, select: { promotionId: true } }))?.promotionId ?? null) : null

  const quote: CheckoutQuoteV1 = {
    version: 1,
    id: randomUUID() as QuoteId,
    cartId: cart.id as CartId,
    cartRevision: cart.revision,
    lines: tax.lines.map((t, i) => {
      const line = cart.lines[i]!
      return {
        variantId: line.variantId as VariantId,
        sku: byId.get(line.variantId)!.sku as Sku,
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
        unitPrice: inr(line.unitPrice.amountPaise),
        lineSubtotal: inr(t.grossPaise),
        discount: inr(t.discountPaise),
        tax: taxLines(t.tax),
        lineTotal: inr(t.totalPaise),
        classification: t.classification,
      }
    }),
    promotionId: promotionId as PromotionId | null,
    subtotal: inr(tax.subtotalPaise),
    discountTotal: inr(tax.discountPaise),
    shippingFee: inr(tax.shipping.feePaise),
    taxTotal: inr(taxTotal),
    grandTotal: inr(grandTotal),
    pricesIncludeTax: first.pricesIncludeTax,
    courierQuoteRef: option.serviceRef,
    expiresAt: expiresAt.toISOString() as IsoDateTime,
    shipping: {
      serviceRef: option.serviceRef,
      courierName: option.courierName,
      mode: option.mode,
      estimatedDeliveryDays: option.estimatedDeliveryDays,
      fee: inr(tax.shipping.feePaise),
      tax: taxLines(tax.shipping.tax),
      total: inr(tax.shipping.totalPaise),
    },
    supply: tax.supply,
    mode: testReasons.length > 0 ? "test" : "live",
    testReasons,
  }
  return { quote, address: { pinCode: address.pinCode, stateCode: address.stateCode } }
}

/** Prices the shopper's bag and stores the quote, bound to its owner, bag and inputs. */
export async function quoteBag(db: Db, owner: Shopper | null, body: Record<string, unknown>, options: QuoteOptions = {}): Promise<CheckoutQuoteV1> {
  const request = parseQuoteRequest(body)
  if (!owner) throw new ApiError(404, "not_found", "not found")
  const now = options.now ?? new Date()
  const { quote, address } = await priceBag(db, owner, request, { ...options, now })
  const print = fingerprintOf(owner, quote, address)
  await db.$transaction(async tx => {
    // Stored only for the bag exactly as priced: a change since the read means this quote is already stale.
    const [locked] = await tx.$queryRaw<{ revision: number }[]>`SELECT revision FROM cart WHERE id = ${quote.cartId}::uuid FOR UPDATE`
    if (!locked || locked.revision !== quote.cartRevision) throw conflict("your bag changed; review it again", { cartRevision: "stale" })
    const row = {
      id: quote.id,
      cartRevision: quote.cartRevision,
      grandTotalPaise: BigInt(quote.grandTotal.amountPaise),
      test: quote.mode === "test",
      quote: quote as unknown as object,
      ownerHash: print.ownerHash,
      fingerprint: print.fingerprint,
      fingerprintVersion: FINGERPRINT_VERSION,
      parts: print.parts,
      expiresAt: new Date(quote.expiresAt),
      createdAt: now,
    }
    await tx.checkoutQuote.deleteMany({ where: { cartId: quote.cartId } })
    await tx.checkoutQuote.create({ data: { cartId: quote.cartId, ...row } })
  })
  return quote
}

export type QuoteCheck = { status: "valid"; quote: CheckoutQuoteV1 }

/**
 * Checks a stored quote before it is used (Stage 12.10; Stage 13 calls this at confirmation).
 *
 * Owner    a quote is found only by its owner: another shopper's quote id, an unknown one, or one
 *          replaced by a newer quote is 404, never revealed.
 * Expiry   at or past `expiresAt` it is 409 quote "expired", however unchanged the bag is.
 * Inputs   the bag is priced again exactly as quoted (same delivery option, same revision) and the
 *          fingerprints compared. A different bag, price, promotion, address, delivery rate or tax
 *          is 409 quote "changed", naming the parts. Stock and availability are checked again: a
 *          short or withdrawn item is 409 quote "changed" with stock "changed".
 * Final    an expired or changed quote is deleted, so it can never become valid again; the shopper
 *          asks for a new one. Checking a valid quote changes nothing.
 */
export async function checkQuote(db: Db, owner: Shopper | null, quoteId: string, options: QuoteOptions = {}): Promise<QuoteCheck> {
  if (!owner || !UUID.test(quoteId)) throw new ApiError(404, "not_found", "not found")
  const now = options.now ?? new Date()
  const row = await db.checkoutQuote.findUnique({ where: { id: quoteId } })
  if (!row || !safeEqual(row.ownerHash, ownerHashOf(owner)) || row.fingerprintVersion !== FINGERPRINT_VERSION) throw new ApiError(404, "not_found", "not found")
  const stored = row.quote as unknown as CheckoutQuoteV1
  const invalidate = async (fields: Record<string, string>, message: string) => {
    await db.checkoutQuote.deleteMany({ where: { id: row.id } })
    return new ApiError(409, "conflict", message, fields)
  }
  if (row.expiresAt.getTime() <= now.getTime()) throw await invalidate({ quote: "expired" }, "this quote has expired; ask for a new one")

  let current: Awaited<ReturnType<typeof priceBag>>
  try {
    current = await priceBag(db, owner, { serviceRef: stored.shipping.serviceRef, cartRevision: row.cartRevision }, { ...options, now })
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    throw await invalidate({ quote: "changed", ...changedFromRefusal(error) }, "your bag or its prices changed; ask for a new quote")
  }
  const again = fingerprintOf(owner, current.quote, current.address)
  if (current.quote.cartId !== row.cartId || !safeEqual(again.fingerprint, row.fingerprint)) {
    const before = row.parts as Record<string, string>
    const changed = Object.fromEntries(FINGERPRINT_PARTS.filter(k => before[k] !== again.parts[k]).map(k => [k, "changed"]))
    throw await invalidate({ quote: "changed", ...changed }, "your bag or its prices changed; ask for a new quote")
  }
  return { status: "valid", quote: stored }
}

/** Which part a pricing refusal points at, for the "changed" answer. */
function changedFromRefusal(error: ApiError): Record<string, string> {
  const fields = error.fields ?? {}
  const values = Object.values(fields)
  if ("cartRevision" in fields || error.status === 404 || error.message === "your bag is empty") return { cart: "changed" }
  if (values.includes("insufficient_stock") || values.includes("unavailable")) return { stock: "changed" }
  if ("shippingAddress" in fields) return { address: "changed" }
  if ("shipping" in fields || "serviceRef" in fields) return { delivery: "changed" }
  if (Object.keys(fields).some(k => k === "tax" || k.startsWith("tax."))) return { tax: "changed" }
  return { cart: "changed" }
}
