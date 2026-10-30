// Order intent (Stage 13.02): a checked quote becomes one pending order, exactly once.
//
// Request  the shopper's own quote id (12.09, 12.10), the grand total they were shown, and an
//          Idempotency-Key header. The total is compared, never adopted: a different total is 409 conflict with expectedGrandTotal
//          amount_mismatch and nothing is created.
// Once     the same key, or the same quote again under a new key (a double click after a reload),
//          returns the original order unchanged (200, replayed). A key used for another quote is 409.
//          Keys are stored as a digest of the owner and the key, so two shoppers' keys never collide
//          and one shopper's key never reveals another's order. The database allows one order per
//          quote (order_one_per_quote) and one per key (submit_key), so parallel submissions still make
//          exactly one.
// Checked  the quote is checked again first (owner, expiry, fingerprint, stock: checkQuote), then the
//          bag is locked and must still be at the quoted revision. The order copies the quote
//          (13.01); the quote is then used up.
// Where    development and staging only until payments exist (production answers 404), and a test
//          quote (sandbox delivery rates or a draft tax profile) never becomes an order in production.
// Stock    (Stage 13.04) the order holds its stock through the Stage 09 reservation code
//          (reserveWithin, the body of reserveStock) in the same transaction as the order: the order
//          and its hold commit together or not at all, with one ledger movement per line and no stock
//          arithmetic of its own. The hold lasts as long as the order is payable (payable_until),
//          within the reservation limits. Not enough stock places nothing (409, insufficient_stock).
// Not here taking payment, releasing expired holds, emptying the bag (later stages).
import { createHash, randomUUID } from "node:crypto"
import { resolveEnvironment } from "@chaanavya/shared/config/env"
import type { Shopper } from "@chaanavya/contracts/modules/common"
import type { CheckoutContactV1, IndianAddressV1 } from "@chaanavya/contracts/modules/checkout"
import type { PlacedOrderV1 } from "@chaanavya/contracts/modules/order"
import { ApiError, UUID } from "../admin/api.ts"
import { lockCartOwner } from "../cart/ownership.ts"
import { checkQuote, type QuoteOptions } from "../checkout/quote.ts"
import { ownerHashOf } from "../checkout/quote-fingerprint.ts"
import type { Db, Tx } from "../db/client.ts"
import { Prisma } from "../db/generated/client.ts"
import { toPaise } from "../db/money.ts"
import { declareOrigin } from "../db/origin.ts"
import { RESERVATION_TTL, reserveWithin } from "../inventory/reservations.ts"
import { InsufficientStockError } from "../inventory/ledger.ts"
import { orderCreateData } from "./snapshot.ts"

type Env = Readonly<Record<string, string | undefined>>

const KEY = /^[A-Za-z0-9_-]{8,100}$/
const notFound = () => new ApiError(404, "not_found", "not found")

export const orderIntentOpen = (env: Env) => resolveEnvironment(env) !== "production"

/** The Idempotency-Key header: required, so a retried submission can never place a second order. */
export function intentKeyOf(value: unknown) {
  if (value === undefined || value === null || value === "") throw new ApiError(428, "precondition_required", "send an Idempotency-Key header with the order")
  if (typeof value !== "string" || !KEY.test(value)) throw new ApiError(400, "invalid_request", "Idempotency-Key must be 8 to 100 letters, digits, - or _", { "Idempotency-Key": "invalid" })
  return value
}

/** The request body: the quote and the total the shopper was shown. Nothing else is read. */
export function parseOrderIntent(body: Record<string, unknown>): { quoteId: string; expectedPaise: number } {
  const problems: Record<string, string> = {}
  const quoteId = typeof body.quoteId === "string" && UUID.test(body.quoteId) ? body.quoteId : null
  if (!quoteId) problems.quoteId = "invalid"
  const expected = body.expectedGrandTotal as { amountPaise?: unknown; currency?: unknown } | null | undefined
  const amount = expected && typeof expected === "object" ? expected.amountPaise : undefined
  const valid = typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 && expected?.currency === "INR"
  if (!valid) problems.expectedGrandTotal = "invalid"
  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "check the highlighted fields", problems)
  return { quoteId: quoteId!, expectedPaise: amount as number }
}

/** The stored submit key: a digest of the owner and their key, so keys are per shopper. */
export const submitKeyOf = (owner: Shopper, key: string) => createHash("sha256").update(`chaanavya.order.intent.v1:${ownerHashOf(owner)}:${key}`).digest("hex")

export const ownerWhere = (owner: Shopper) => (owner.kind === "customer" ? { userId: owner.customerId } : { guestSessionId: owner.guestSessionId })

export const VIEW = {
  id: true,
  number: true,
  status: true,
  quoteRef: true,
  grandTotalPaise: true,
  currency: true,
  shippingSnapshot: true,
  taxSnapshot: true,
  payableUntil: true,
  createdAt: true,
  items: { orderBy: { sku: "asc" }, select: { sku: true, productTitle: true, variantTitle: true, quantity: true, lineTotalPaise: true } },
} satisfies Prisma.OrderSelect

export type ViewRow = Prisma.OrderGetPayload<{ select: typeof VIEW }>

export function view(o: ViewRow): PlacedOrderV1 {
  const shipping = o.shippingSnapshot as { ratesMode?: string } | null
  const tax = o.taxSnapshot as { profileApproved?: boolean } | null
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    quoteId: o.quoteRef!,
    grandTotal: { amountPaise: toPaise(o.grandTotalPaise), currency: o.currency as "INR" },
    test: shipping?.ratesMode !== "live" || tax?.profileApproved !== true,
    payableUntil: o.payableUntil!.toISOString(),
    items: o.items.map(i => ({ sku: i.sku, productTitle: i.productTitle, variantTitle: i.variantTitle, quantity: i.quantity, lineTotal: { amountPaise: toPaise(i.lineTotalPaise), currency: "INR" } })),
    createdAt: o.createdAt.toISOString(),
  } as PlacedOrderV1
}

/** An order this owner already placed with this key or from this quote, checked against the request. */
async function earlier(db: Db | Tx, owner: Shopper, submitKey: string, quoteId: string, expectedPaise: number): Promise<PlacedOrderV1 | null> {
  const byKey = await db.order.findUnique({ where: { submitKey }, select: VIEW })
  const found = byKey ?? (await db.order.findFirst({ where: { quoteRef: quoteId, ...ownerWhere(owner) }, select: VIEW }))
  if (!found) return null
  if (found.quoteRef !== quoteId) throw new ApiError(409, "conflict", "this Idempotency-Key was used for another order", { "Idempotency-Key": "reused" })
  if (toPaise(found.grandTotalPaise) !== expectedPaise) throw new ApiError(409, "conflict", "the total you saw is not this order's total", { expectedGrandTotal: "amount_mismatch" })
  return view(found)
}

async function catalogueFacts(db: Db, variantIds: string[]) {
  const rows = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, mediaId: true, product: { select: { handle: true, media: { where: { status: "approved", removedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, url: true } } } } },
  })
  return new Map(rows.map(v => [v.id, { handle: v.product.handle, imageUrl: (v.product.media.find(m => m.id === v.mediaId) ?? v.product.media[0])?.url ?? null }]))
}

/**
 * Places one pending order from the shopper's checked quote. `created` is false when the request
 * repeats an earlier one, which is answered with the original order.
 */
export async function placeOrderIntent(
  db: Db,
  owner: Shopper | null,
  key: string,
  body: Record<string, unknown>,
  options: QuoteOptions & { correlationId?: string } = {},
): Promise<{ order: PlacedOrderV1; created: boolean }> {
  const env = options.env ?? process.env
  if (!orderIntentOpen(env)) throw notFound()
  if (!owner) throw notFound()
  const { quoteId, expectedPaise } = parseOrderIntent(body)
  const submitKey = submitKeyOf(owner, key)

  // A repeat is answered before anything is checked again, so a retry stays a success.
  const repeat = await earlier(db, owner, submitKey, quoteId, expectedPaise)
  if (repeat) return { order: repeat, created: false }

  const { quote } = await checkQuote(db, owner, quoteId, options)
  if (quote.grandTotal.amountPaise !== expectedPaise) throw new ApiError(409, "conflict", "the total you saw is not this quote's total; review your order again", { expectedGrandTotal: "amount_mismatch" })
  if (quote.mode === "test" && resolveEnvironment(env) === "production") throw new ApiError(409, "conflict", "a test quote cannot become an order", { quote: "test" })

  const quoteRow = await db.checkoutQuote.findUnique({ where: { id: quoteId }, select: { fingerprint: true } })
  const contactRow = await db.cartContact.findUnique({ where: { cartId: quote.cartId }, select: { email: true, shippingAddress: true, updatedAt: true } })
  if (!quoteRow || !contactRow) throw new ApiError(409, "conflict", "your bag changed; ask for a new quote", { quote: "changed" })
  const contact: CheckoutContactV1 = { email: contactRow.email, shippingAddress: contactRow.shippingAddress as unknown as IndianAddressV1, marketing: "not_offered", updatedAt: contactRow.updatedAt.toISOString() as CheckoutContactV1["updatedAt"] }
  const catalogue = await catalogueFacts(db, quote.lines.map(l => l.variantId))
  const data = orderCreateData({ quote, contact, owner, fingerprint: quoteRow.fingerprint, submitKey, catalogue })

  try {
    return await db.$transaction(
      async tx => {
        // The owner first, as every cart writer does, then the bag: parallel submissions queue here.
        if (!(await lockCartOwner(tx, owner))) throw notFound()
        const again = await earlier(tx, owner, submitKey, quoteId, expectedPaise)
        if (again) return { order: again, created: false }
        const [cart] = await tx.$queryRaw<{ revision: number }[]>`SELECT revision FROM cart WHERE id = ${quote.cartId}::uuid FOR UPDATE`
        if (!cart || cart.revision !== quote.cartRevision) throw new ApiError(409, "conflict", "your bag changed; ask for a new quote", { cartRevision: "stale" })
        const placed = await tx.order.create({ data, select: VIEW })
        // The order's stock, held with the Stage 09 reservation itself, in this same transaction.
        const now = options.now ?? new Date()
        const window = Math.ceil((placed.payableUntil!.getTime() - now.getTime()) / 1000)
        const held = await reserveWithin(tx, {
          orderId: placed.id,
          lines: quote.lines.map(l => ({ variantId: l.variantId, quantity: l.quantity })),
          ttlSeconds: Math.min(RESERVATION_TTL.maxSeconds, Math.max(RESERVATION_TTL.minSeconds, window)),
          idempotencyKey: `order:${placed.id}`,
          correlationId: options.correlationId ?? randomUUID(),
        })
        if (!held.ok) {
          const variants = "variantIds" in held ? held.variantIds : []
          throw new ApiError(409, "conflict", "some items can no longer be held for you; review your bag again", variants.length ? Object.fromEntries(variants.map(id => [`variants.${id}`, held.reason])) : { stock: held.reason })
        }
        // The order's first event (Stage 13.08): who placed it, from which request, with no personal data.
        const correlationId = options.correlationId ?? randomUUID()
        const actor = owner.kind === "customer" ? { kind: "customer" as const, id: owner.customerId } : { kind: "guest" as const, id: null }
        await declareOrigin(tx, { actor, correlationId, reason: "order_placed_from_checked_quote" })
        await tx.orderEvent.create({
          data: {
            orderId: placed.id,
            kind: "placed",
            subjectId: placed.id,
            fromState: null,
            toState: placed.status,
            actorKind: actor.kind,
            actorId: actor.id,
            correlationId,
            reason: "order_placed_from_checked_quote",
            context: { number: placed.number, quoteId, grandTotalPaise: toPaise(placed.grandTotalPaise), lineCount: quote.lines.length, reservationId: held.reservationId, test: view(placed).test },
          },
        })
        // The quote is used up: it can never place a second order.
        await tx.checkoutQuote.deleteMany({ where: { id: quoteId } })
        return { order: view(placed), created: true }
      },
      { maxWait: 10_000, timeout: 15_000 },
    )
  } catch (error) {
    // Another order took the last units between the quote check and the hold: nothing was placed.
    if (error instanceof InsufficientStockError) throw new ApiError(409, "conflict", "some items no longer have enough stock; review your bag again", { [`variants.${error.variantId}`]: "insufficient_stock" })
    // Another submission won the race on the key or the quote: answer with its order.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await earlier(db, owner, submitKey, quoteId, expectedPaise)
      if (winner) return { order: winner, created: false }
    }
    throw error
  }
}
