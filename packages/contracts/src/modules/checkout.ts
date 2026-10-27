import type { AddressId, CartId, ContractVersion, CountryCode, IdempotencyKey, IsoDateTime, OrderId, PromotionId, QuoteId, Result, Shopper, Sku, VariantId } from "./common.ts"
import type { MoneyPaise, TaxClassificationV1, TaxLineV1 } from "./money.ts"
import type { PaymentSessionV1 } from "./payment.ts"

// Checkout module: India address, quote (immutable price breakdown) and confirmation.
// Every amount in a quote is computed on the server from catalogue prices, promotions, tax rules
// and the courier quote. A client may echo the total it saw; it is compared, never adopted.

/**
 * An Indian address as entered (Stage 12.01). Used for a guest's details and as the frozen snapshot
 * an order keeps; checked on the server by apps/api/src/checkout/address.ts.
 */
export type IndianAddressV1 = {
  /** Recipient. */
  name: string
  /** Indian mobile number in E.164, for example +919876543210. */
  phone: string
  line1: string
  line2: string | null
  landmark: string | null
  city: string
  district: string
  /** ISO 3166-2:IN subdivision code, for example "IN-KA". */
  stateCode: string
  /** Six digits, first digit 1 to 9. */
  pinCode: string
  country: CountryCode
}

/**
 * What is known about delivering to a PIN (Stage 12.02). A well-formed PIN is not a deliverable one:
 * `delivery` stays "unknown" until a courier answers, and only "serviceable" sets `deliverable`.
 */
export type DeliveryCheckV1 = {
  pinCode: string
  format: "valid" | "invalid"
  delivery: "unknown" | "serviceable" | "not_serviceable"
  deliverable: boolean
  /**
   * Who answered (Stage 12.08): "none" before any courier, "test" for the sandbox courier, "live" for
   * a connected courier. A test answer shows what the sandbox said but never sets `deliverable`.
   */
  source: "none" | "test" | "live"
}

/**
 * The contact step for a bag (Stage 12.04): where order emails go and where to deliver. A guest
 * gives it without an account. The phone is the delivery phone on the address. Marketing sign-up is
 * not offered yet (owner decision, 26 October 2026).
 */
export type CheckoutContactV1 = {
  email: string
  shippingAddress: IndianAddressV1
  marketing: "not_offered"
  updatedAt: IsoDateTime
}

/** An entry in a verified customer's address book. Guests have none; orders copy the address. */
export type SavedAddressV1 = {
  version: ContractVersion
  id: AddressId
  address: IndianAddressV1
  isDefault: boolean
  updatedAt: IsoDateTime
}

export type QuoteRequestV1 = {
  cartId: CartId
  cartRevision: number
  shippingAddress: IndianAddressV1
  billingAddress: IndianAddressV1 | null
  promotionCode: string | null
  email: string
}

export type QuoteLineV1 = {
  variantId: VariantId
  sku: Sku
  quantity: number
  unitPrice: MoneyPaise
  lineSubtotal: MoneyPaise
  discount: MoneyPaise
  tax: TaxLineV1[]
  lineTotal: MoneyPaise
}

export type QuoteV1 = {
  version: ContractVersion
  id: QuoteId
  cartId: CartId
  cartRevision: number
  owner: Shopper
  lines: QuoteLineV1[]
  promotionId: PromotionId | null
  subtotal: MoneyPaise
  discountTotal: MoneyPaise
  shippingFee: MoneyPaise
  taxTotal: MoneyPaise
  grandTotal: MoneyPaise
  /** Whether catalogue prices include GST. Proposed decision, docs/DECISIONS.md 014. */
  pricesIncludeTax: boolean
  courierQuoteRef: string | null
  expiresAt: IsoDateTime
}

/**
 * What the shopper sees for a checkout quote (Stage 12.09): `QuoteV1` without the owner, with each
 * line's tax classification and the chosen delivery option. Every amount is worked out on the server
 * from the catalogue, the applied promotion, the courier's offer and the tax profile; nothing the
 * browser sends is used as an amount. Only the latest quote for a bag is kept.
 */
export type CheckoutQuoteLineV1 = QuoteLineV1 & { title: string; variantTitle: string; classification: TaxClassificationV1 }

export type CheckoutQuoteV1 = Omit<QuoteV1, "owner" | "lines"> & {
  lines: CheckoutQuoteLineV1[]
  shipping: {
    serviceRef: string
    courierName: string
    mode: "air" | "surface"
    estimatedDeliveryDays: number | null
    /** The fee charged, as the courier quoted it (no markup or free-delivery rule yet). */
    fee: MoneyPaise
    /** GST on the fee, shared across lines by value (owner decision, 27 October 2026). */
    tax: TaxLineV1[]
    total: MoneyPaise
  }
  supply: "intra" | "inter"
  /** "test": sandbox delivery rates or an unapproved tax profile; such a quote can never become a real order. */
  mode: "test" | "live"
  /** Why a quote is a test, when it is. */
  testReasons: ("test_shipping_rates" | "tax_profile_unapproved")[]
}

export type ConfirmCheckoutV1 = {
  quoteId: QuoteId
  /** The total the shopper saw. A mismatch with the stored quote rejects the request (amount_mismatch). */
  expectedGrandTotal: MoneyPaise
  idempotencyKey: IdempotencyKey
}

export type CheckoutConfirmationV1 = { version: ContractVersion; orderId: OrderId; payment: PaymentSessionV1 }

export interface CheckoutService {
  /** Re-prices the cart, checks stock, publication, serviceability and promotion; stores a quote. */
  previewQuote(owner: Shopper, request: QuoteRequestV1): Promise<Result<QuoteV1>>
  /**
   * Re-checks the quote, atomically reserves stock and creates one pending order, then starts a
   * payment attempt. The same idempotency key always returns the same order (Stage 13).
   */
  confirm(owner: Shopper, request: ConfirmCheckoutV1): Promise<Result<CheckoutConfirmationV1>>
}
