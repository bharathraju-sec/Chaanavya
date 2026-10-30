// The order snapshot (Stage 13.01): what an order is sold on, copied from a checked checkout quote
// (Stage 12.09, 12.10) when it is placed. Pure: the caller passes the quote, the contact step, the
// owner, the quote's fingerprint and the catalogue's handle and photo for each variant; nothing here
// reads the database or a clock. Every amount is the quote's, in paise; nothing is re-priced.
//
// Identifiers  the order id is a UUID (database default); the public number is CHV- and at least
//              six digits from a sequence (database default, checked by order_number_format).
// Snapshot     customer (guest or customer, email, name, phone), every line (SKU, titles, handle,
//              photo, HSN, quantity, unit price, discount, tax lines, line total, tax
//              classification), the tax basis, the delivery option with its GST and rate mode, the
//              totals, the delivery address and the quote's fingerprint.
// Frozen       the database refuses any later change to these (triggers order_snapshot_immutable and
//              order_item_snapshot_immutable); only status, fulfilment status and account links move.
import type { Shopper } from "@chaanavya/contracts/modules/common"
import type { CheckoutContactV1, CheckoutQuoteV1 } from "@chaanavya/contracts/modules/checkout"
import type { OrderSnapshotV1 } from "@chaanavya/contracts/modules/order"
import type { Prisma } from "../db/generated/client.ts"

export type CatalogueFacts = ReadonlyMap<string, { handle: string; imageUrl: string | null }>

const HEX64 = /^[0-9a-f]{64}$/

/** The snapshot an order placed from this quote carries. */
export function orderSnapshotOf(quote: CheckoutQuoteV1, contact: CheckoutContactV1, owner: Shopper, fingerprint: string): OrderSnapshotV1 {
  const first = quote.lines[0]?.classification
  if (!first) throw new Error("an order needs at least one line")
  return {
    customer: { kind: owner.kind, email: contact.email, name: contact.shippingAddress.name, phone: contact.shippingAddress.phone },
    tax: {
      taxProfileId: first.taxProfileId,
      profileApproved: first.profileApproved,
      supply: first.supply,
      sellerStateCode: first.sellerStateCode,
      deliveryStateCode: first.deliveryStateCode,
      pricesIncludeTax: first.pricesIncludeTax,
      rounding: first.rounding,
    },
    shipping: {
      serviceRef: quote.shipping.serviceRef,
      courierName: quote.shipping.courierName,
      mode: quote.shipping.mode,
      estimatedDeliveryDays: quote.shipping.estimatedDeliveryDays,
      fee: { ...quote.shipping.fee },
      tax: quote.shipping.tax.map(t => ({ ...t, amount: { ...t.amount } })),
      total: { ...quote.shipping.total },
      ratesMode: quote.testReasons.includes("test_shipping_rates") ? "test" : "live",
    },
    quoteFingerprint: fingerprint,
  }
}

/**
 * The database row for an order placed from this quote: the order and its lines, every value copied.
 * Refuses a quote it cannot copy faithfully rather than filling a gap.
 */
export function orderCreateData(input: {
  quote: CheckoutQuoteV1
  contact: CheckoutContactV1
  owner: Shopper
  fingerprint: string
  submitKey: string
  catalogue: CatalogueFacts
}): Prisma.OrderCreateInput {
  const { quote, contact, owner, fingerprint, submitKey, catalogue } = input
  if (!HEX64.test(fingerprint)) throw new Error("an order needs the quote's fingerprint")
  if (quote.lines.length === 0) throw new Error("an order needs at least one line")
  const missing = quote.lines.filter(l => !catalogue.has(l.variantId)).map(l => l.sku)
  if (missing.length > 0) throw new Error(`no catalogue facts for ${missing.join(", ")}`)
  if (quote.lines.some(l => l.classification.taxProfileId !== quote.lines[0]!.classification.taxProfileId)) throw new Error("every line must be taxed with one profile")

  const snapshot = orderSnapshotOf(quote, contact, owner, fingerprint)
  const json = (value: unknown) => value as Prisma.InputJsonValue
  return {
    email: contact.email,
    ...(owner.kind === "customer" ? { user: { connect: { id: owner.customerId } } } : { guestSession: { connect: { id: owner.guestSessionId } } }),
    quoteRef: quote.id,
    ...(quote.promotionId ? { promotion: { connect: { id: quote.promotionId } } } : {}),
    subtotalPaise: BigInt(quote.subtotal.amountPaise),
    discountTotalPaise: BigInt(quote.discountTotal.amountPaise),
    shippingFeePaise: BigInt(quote.shippingFee.amountPaise),
    taxTotalPaise: BigInt(quote.taxTotal.amountPaise),
    grandTotalPaise: BigInt(quote.grandTotal.amountPaise),
    currency: quote.grandTotal.currency,
    pricesIncludeTax: quote.pricesIncludeTax,
    shippingAddress: json({ ...contact.shippingAddress }),
    billingAddress: undefined,
    submitKey,
    customerSnapshot: json(snapshot.customer),
    taxSnapshot: json(snapshot.tax),
    shippingSnapshot: json(snapshot.shipping),
    quoteFingerprint: fingerprint,
    // Bound to its checkout (Stage 13.03): the bag it came from, and the quote's expiry as its payment window.
    cart: { connect: { id: quote.cartId } },
    payableUntil: new Date(quote.expiresAt),
    items: {
      create: quote.lines.map(l => {
        const facts = catalogue.get(l.variantId)!
        return {
          variant: { connect: { id: l.variantId } },
          sku: l.sku,
          productTitle: l.title,
          variantTitle: l.variantTitle,
          handle: facts.handle,
          imageUrl: facts.imageUrl,
          hsnCode: l.classification.hsnCode,
          quantity: l.quantity,
          unitPricePaise: BigInt(l.unitPrice.amountPaise),
          discountPaise: BigInt(l.discount.amountPaise),
          taxPaise: BigInt(l.tax.reduce((sum, t) => sum + t.amount.amountPaise, 0)),
          taxLines: json(l.tax),
          lineTotalPaise: BigInt(l.lineTotal.amountPaise),
          currency: l.lineTotal.currency,
          taxClassification: json({ ...l.classification }),
        }
      }),
    },
  }
}
