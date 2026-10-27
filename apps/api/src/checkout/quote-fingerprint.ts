// What a checkout quote is bound to (Stage 12.10). A quote is valid only for the owner, the bag and
// the inputs it was priced from; the fingerprint is a SHA-256 over all of them, and each part has its
// own digest so a refusal can say what changed. Pure: no database, no clock.
//
// Owner     the guest session or customer, as a namespaced digest: the id itself is never stored with
//           the quote or returned.
// Parts     cart      the bag id, its revision, and each line's variant and quantity
//           price     each line's catalogue unit price and the subtotal
//           promotion the applied promotion and the discount on each line
//           address   the delivery PIN and state
//           delivery  the chosen offer: reference, courier, mode, fee, and whether rates were test
//                     or live (the rate version)
//           tax       each line's classification (profile, category, HSN, rate, supply, rounding),
//                     every tax line, the fee's tax, and whether the profile was approved
// Total     the grand total is bound in the fingerprint itself, outside the parts.
// Not bound titles, photos and delivery-day estimates, which do not change what is charged.
// Version   FINGERPRINT_VERSION changes whenever the parts change, so an old quote never matches.
import { createHash, timingSafeEqual } from "node:crypto"
import type { Shopper } from "@chaanavya/contracts/modules/common"
import type { CheckoutQuoteV1 } from "@chaanavya/contracts/modules/checkout"

export const FINGERPRINT_VERSION = 1
export const FINGERPRINT_PARTS = ["cart", "price", "promotion", "address", "delivery", "tax"] as const
export type FingerprintPart = (typeof FINGERPRINT_PARTS)[number]

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

export function ownerHashOf(owner: Shopper): string {
  const id = owner.kind === "guest" ? owner.guestSessionId : owner.customerId
  return sha256(`chaanavya.quote.owner.v${FINGERPRINT_VERSION}:${owner.kind}:${id}`)
}

/** Equal-length hex digests compared in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8")
  const y = Buffer.from(b, "utf8")
  return x.length === y.length && timingSafeEqual(x, y)
}

const paise = (m: { amountPaise: number; currency: string }) => `${m.amountPaise}:${m.currency}`

/** The values each part is made of, in a fixed order (arrays and fixed keys only, so JSON is canonical). */
export function partValues(quote: CheckoutQuoteV1, address: { pinCode: string; stateCode: string }): Record<FingerprintPart, unknown[]> {
  return {
    cart: [quote.cartId, quote.cartRevision, quote.lines.map(l => [l.variantId, l.sku, l.quantity])],
    price: [quote.lines.map(l => [l.variantId, paise(l.unitPrice), paise(l.lineSubtotal)]), paise(quote.subtotal)],
    promotion: [quote.promotionId, paise(quote.discountTotal), quote.lines.map(l => paise(l.discount))],
    address: [address.pinCode, address.stateCode],
    delivery: [quote.shipping.serviceRef, quote.shipping.courierName, quote.shipping.mode, paise(quote.shipping.fee), paise(quote.shipping.total), quote.testReasons.includes("test_shipping_rates") ? "test" : "live"],
    tax: [
      quote.supply,
      quote.pricesIncludeTax,
      quote.lines.map(l => {
        const c = l.classification
        return [c.taxProfileId, c.profileApproved, c.taxCategory, c.hsnCode, c.rateBasisPoints, c.supply, c.sellerStateCode, c.deliveryStateCode, c.pricesIncludeTax, c.rounding, l.tax.map(t => [t.component, t.rateBasisPoints, paise(t.amount)]), paise(l.lineTotal)]
      }),
      quote.shipping.tax.map(t => [t.component, t.rateBasisPoints, paise(t.amount)]),
      paise(quote.taxTotal),
    ],
  }
}

export function fingerprintOf(owner: Shopper, quote: CheckoutQuoteV1, address: { pinCode: string; stateCode: string }) {
  const values = partValues(quote, address)
  const parts = Object.fromEntries(FINGERPRINT_PARTS.map(k => [k, sha256(JSON.stringify([k, values[k]]))])) as Record<FingerprintPart, string>
  const ownerHash = ownerHashOf(owner)
  const fingerprint = sha256(JSON.stringify([`v${FINGERPRINT_VERSION}`, ownerHash, FINGERPRINT_PARTS.map(k => parts[k]), paise(quote.grandTotal)]))
  return { ownerHash, parts, fingerprint }
}
