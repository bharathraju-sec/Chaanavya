// Shared vocabulary for the Chaanavya-owned commerce modules (Stage 02, design only).
// These types describe module boundaries. Nothing here is a working order, payment, stock or
// courier implementation, and nothing in the storefront imports these modules yet.
//
// Runtime rule for this folder: only state-machines.ts and invariants.ts hold runtime code, and
// every other import is `import type`, so the contract tests can run on Node's type stripping
// without a build step (see tests/contracts/).

/** DTOs that cross a module or network boundary carry their contract version. */
export type ContractVersion = 1

type Brand<T, B extends string> = T & { readonly __brand: B }

export type ProductId = Brand<string, "ProductId">
export type VariantId = Brand<string, "VariantId">
export type Sku = Brand<string, "Sku">
export type CollectionId = Brand<string, "CollectionId">
export type MediaId = Brand<string, "MediaId">
export type CartId = Brand<string, "CartId">
export type CartLineId = Brand<string, "CartLineId">
export type QuoteId = Brand<string, "QuoteId">
export type OrderId = Brand<string, "OrderId">
/** Customer-facing order number. Format is a proposed decision (docs/DECISIONS.md 016). */
export type OrderNumber = Brand<string, "OrderNumber">
export type ReservationId = Brand<string, "ReservationId">
export type PaymentAttemptId = Brand<string, "PaymentAttemptId">
export type RefundId = Brand<string, "RefundId">
export type ShipmentId = Brand<string, "ShipmentId">
export type ReturnId = Brand<string, "ReturnId">
export type PromotionId = Brand<string, "PromotionId">
export type CustomerId = Brand<string, "CustomerId">
export type GuestSessionId = Brand<string, "GuestSessionId">
export type StaffId = Brand<string, "StaffId">
export type AuditEventId = Brand<string, "AuditEventId">
export type CorrelationId = Brand<string, "CorrelationId">
/** Client-generated key that makes a mutation safe to retry; the server returns the first result. */
export type IdempotencyKey = Brand<string, "IdempotencyKey">
/** ISO 8601 timestamp in UTC, for example 2026-10-15T08:00:00.000Z. */
export type IsoDateTime = Brand<string, "IsoDateTime">

/** India-first, single-brand merchant (docs/DECISIONS.md 012). */
export type CurrencyCode = "INR"
export type CountryCode = "IN"

export type StaffRole = "OWNER" | "ADMIN" | "STAFF"

/** Who asked for an action. Server code derives this from the session, never from request bodies. */
export type Actor =
  | { kind: "customer"; customerId: CustomerId }
  | { kind: "guest"; guestSessionId: GuestSessionId }
  | { kind: "staff"; staffId: StaffId; role: StaffRole }
  | { kind: "system"; process: string }
  | { kind: "provider"; provider: ProviderName }

/** Owner of a cart or order: a signed-in customer or a guest session. */
export type Shopper = Extract<Actor, { kind: "customer" | "guest" }>

export type PaymentProviderName = "razorpay" | "phonepe"
export type CourierProviderName = "shiprocket"
export type NotificationProviderName = "email" | "sms" | "whatsapp"
export type ProviderName = PaymentProviderName | CourierProviderName | NotificationProviderName

export type DomainErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "conflict"
  | "out_of_stock"
  | "price_changed"
  | "quote_expired"
  | "amount_mismatch"
  | "illegal_transition"
  | "unserviceable"
  | "provider_unavailable"

export type DomainError = { code: DomainErrorCode; message: string; retryable: boolean }

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError }

export type Page<T> = { items: T[]; nextCursor: string | null }

/** IDs kept from Shopify for migration and reconciliation only (Stage 04 and 09). */
export type LegacyShopifyRef = { shopifyGid: string } | null
