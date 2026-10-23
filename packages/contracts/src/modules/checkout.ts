import type { CartId, ContractVersion, CountryCode, IdempotencyKey, IsoDateTime, OrderId, PromotionId, QuoteId, Result, Shopper, Sku, VariantId } from "./common.ts"
import type { MoneyPaise, TaxLineV1 } from "./money.ts"
import type { PaymentSessionV1 } from "./payment.ts"

// Checkout module: India address, quote (immutable price breakdown) and confirmation.
// Every amount in a quote is computed on the server from catalogue prices, promotions, tax rules
// and the courier quote. A client may echo the total it saw; it is compared, never adopted.

export type IndianAddressV1 = {
  name: string
  /** E.164, for example +919876543210. */
  phone: string
  line1: string
  line2: string | null
  landmark: string | null
  city: string
  /** ISO 3166-2:IN subdivision code, for example "IN-KA". */
  stateCode: string
  /** Six digits, first digit 1 to 9. */
  pinCode: string
  country: CountryCode
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
