import type { Actor, ContractVersion, IdempotencyKey, IsoDateTime, OrderId, OrderNumber, QuoteId, ReservationId, Result, Shopper, Sku, VariantId } from "./common.ts"
import type { IndianAddressV1 } from "./checkout.ts"
import type { MoneyPaise, TaxLineV1 } from "./money.ts"
import type { PaymentSummaryV1 } from "./payment.ts"
import type { FulfilmentStatus, GuardFacts, OrderStatus } from "./state-machines.ts"

// Order module. Authority: Chaanavya database. Payment status is not stored on the order: the
// payment module owns it and the order only carries a derived, read-only summary.

/** Frozen copy of what was bought. Later catalogue edits never change it (Stage 04, S04-003). */
export type OrderItemSnapshotV1 = {
  variantId: VariantId
  sku: Sku
  productTitle: string
  variantTitle: string
  handle: string
  imageUrl: string | null
  hsnCode: string | null
  quantity: number
  unitPrice: MoneyPaise
  discount: MoneyPaise
  tax: TaxLineV1[]
  lineTotal: MoneyPaise
}

export type OrderTotalsV1 = { subtotal: MoneyPaise; discountTotal: MoneyPaise; shippingFee: MoneyPaise; taxTotal: MoneyPaise; grandTotal: MoneyPaise }

export type OrderV1 = {
  version: ContractVersion
  id: OrderId
  number: OrderNumber
  owner: Shopper
  email: string
  status: OrderStatus
  fulfilmentStatus: FulfilmentStatus
  /** Derived from the payment module at read time; never written by order code. */
  payment: PaymentSummaryV1
  items: OrderItemSnapshotV1[]
  totals: OrderTotalsV1
  quoteId: QuoteId
  reservationId: ReservationId
  shippingAddress: IndianAddressV1
  billingAddress: IndianAddressV1 | null
  submitKey: IdempotencyKey
  createdAt: IsoDateTime
  /** Set only for orders imported from Shopify for support and reconciliation. */
  legacyShopifyOrderName: string | null
}

export type OrderTransitionCommandV1 = {
  orderId: OrderId
  to: OrderStatus
  actor: Actor
  reason: string
  idempotencyKey: IdempotencyKey
}

export type OrderTransitionOutcomeV1 = { order: OrderV1; outcome: "applied" | "noop"; facts: GuardFacts }

export interface OrderService {
  /** Enforces ownership: shoppers see their own orders only; staff need the orders permission. */
  getOrder(actor: Actor, orderId: OrderId): Promise<Result<OrderV1>>
  listOrders(actor: Actor, cursor: string | null): Promise<Result<{ items: OrderV1[]; nextCursor: string | null }>>
  /** Loads guard facts, calls planTransition, writes the change and an audit event in one transaction. */
  transition(command: OrderTransitionCommandV1): Promise<Result<OrderTransitionOutcomeV1>>
}
