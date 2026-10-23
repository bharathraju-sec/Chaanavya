import type { CartId, CartLineId, ContractVersion, IdempotencyKey, IsoDateTime, Result, Shopper, VariantId } from "./common.ts"
import type { MoneyPaise } from "./money.ts"

// Cart module. A cart is a shopper's intention, not a stock claim: adding to cart never reserves
// or decrements inventory (reservation starts at checkout confirmation, see checkout.ts).

/** What a browser may send for a line. There is intentionally no price field. */
export type CartLineInputV1 = { variantId: VariantId; quantity: number }

export type CartIssueV1 =
  | { kind: "price_changed"; lineId: CartLineId; previous: MoneyPaise; current: MoneyPaise }
  | { kind: "unavailable"; lineId: CartLineId }
  | { kind: "quantity_reduced"; lineId: CartLineId; requested: number; allowed: number }

export type CartLineV1 = {
  id: CartLineId
  variantId: VariantId
  quantity: number
  /** Display copy filled by the server from the catalogue on every read. */
  title: string
  variantTitle: string
  handle: string
  imageUrl: string | null
  unitPrice: MoneyPaise
}

export type CartV1 = {
  version: ContractVersion
  id: CartId
  owner: Shopper
  /** Increments on every change; quotes bind to a revision so a stale quote cannot be confirmed. */
  revision: number
  lines: CartLineV1[]
  /** Server-computed from catalogue prices; display only, re-priced again at quote time. */
  subtotal: MoneyPaise
  issues: CartIssueV1[]
  expiresAt: IsoDateTime
}

export interface CartService {
  getCart(owner: Shopper, cartId: CartId): Promise<Result<CartV1>>
  addLines(owner: Shopper, cartId: CartId | null, lines: CartLineInputV1[], key: IdempotencyKey): Promise<Result<CartV1>>
  updateLine(owner: Shopper, cartId: CartId, lineId: CartLineId, quantity: number, key: IdempotencyKey): Promise<Result<CartV1>>
  removeLines(owner: Shopper, cartId: CartId, lineIds: CartLineId[], key: IdempotencyKey): Promise<Result<CartV1>>
  /** On sign-in: merges the guest cart into the customer's, de-duplicating variants. */
  mergeGuestCart(customer: Extract<Shopper, { kind: "customer" }>, guestCartId: CartId): Promise<Result<CartV1>>
}
