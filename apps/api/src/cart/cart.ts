// Guest cart persistence (Stage 11.02): the bag lives in the database, owned by a guest session or
// a signed-in customer (rules in ./ownership.ts). The browser sends only a variant and a quantity;
// titles, photos and prices are read from the live catalogue on every read, so a price can never
// come from the browser. A cart is an intention, not a stock claim: nothing here reserves stock.
//
// What a shopper gets back never names them: no user, guest session or cookie value, only the
// cart, its lines and its revision. The guest cookie is the only handle, and it is HttpOnly.
//
// Every change runs in one transaction that locks the cart row first, so concurrent changes to one
// cart apply one after another, then records the change with the revision compare-and-set.
import { createHash } from "node:crypto"
import type { Shopper } from "@chaanavya/contracts/modules/common"
import { ApiError } from "../admin/api.ts"
import { PUBLIC_PRODUCT } from "../catalogue/public.ts"
import type { Db, Tx } from "../db/client.ts"
import { Prisma } from "../db/generated/client.ts"
import { toPaise } from "../db/money.ts"
import { checkAppliedPromotion, checkPromotion } from "../promotions/check.ts"
import type { PromotionRefusal } from "../promotions/validity.ts"
import { findCurrentCart, findOwnedCart, openCart, ownedBy, renewCart } from "./ownership.ts"

export const CART_LIMITS = { maxQuantity: 10, maxLines: 30 }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const notFound = () => new ApiError(404, "not_found", "not found")

const LINE_FIELDS = {
  id: true,
  quantity: true,
  variant: {
    select: {
      id: true,
      title: true,
      pricePaise: true,
      currency: true,
      mediaId: true,
      archivedAt: true,
      product: {
        select: {
          id: true,
          handle: true,
          title: true,
          media: { where: { status: "approved", removedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, url: true } },
        },
      },
    },
  },
} satisfies Prisma.CartLineSelect

export type CartView = {
  version: 1
  id: string
  revision: number
  lines: {
    id: string
    variantId: string
    quantity: number
    title: string
    variantTitle: string
    handle: string
    imageUrl: string | null
    unitPrice: { amountPaise: number; currency: string }
  }[]
  subtotal: { amountPaise: number; currency: string }
  /** The applied promo code, checked again on this read; null when none is applied. */
  promotion: { code: string; applied: true } | { code: string; applied: false; reason: PromotionRefusal } | null
  /** What the applied code takes off now (0 when none applies); never more than the subtotal. */
  discount: { amountPaise: number; currency: string }
  /** subtotal minus discount. Display only: the quote prices the bag again, with shipping and tax. */
  total: { amountPaise: number; currency: string }
  issues: { kind: "unavailable"; lineId: string }[]
  expiresAt: string
}

/** The shopper's live cart as the bag shows it, or null when they have none. */
export async function readCart(db: Db | Tx, owner: Shopper, now = new Date()): Promise<CartView | null> {
  const cart = await findCurrentCart(db, owner, now)
  return cart ? viewOf(db, cart, owner, now) : null
}

/** One cart by id, only if it is the owner's live cart; null for every refusal (callers answer not_found). */
export async function readOwnedCart(db: Db | Tx, owner: Shopper, cartId: string, now = new Date()): Promise<CartView | null> {
  const cart = await findOwnedCart(db, owner, cartId, now)
  return cart ? viewOf(db, cart, owner, now) : null
}

async function viewOf(db: Db | Tx, cart: { id: string; revision: number; promotionId: string | null; expiresAt: Date }, owner: Shopper, now: Date): Promise<CartView> {
  const lines = await db.cartLine.findMany({ where: { cartId: cart.id }, orderBy: { createdAt: "asc" }, select: LINE_FIELDS })
  const productIds = [...new Set(lines.map(l => l.variant.product.id))]
  const publicIds = productIds.length ? await db.product.findMany({ where: { ...PUBLIC_PRODUCT, id: { in: productIds } }, select: { id: true } }) : []
  const live = new Set(publicIds.map(p => p.id))
  const issues: CartView["issues"] = []
  let subtotal = 0
  const view = lines.map(line => {
    const v = line.variant
    const unitPrice = toPaise(v.pricePaise)
    // A product taken down or a size withdrawn since it was added stays in the bag, flagged and not counted.
    if (v.archivedAt || !live.has(v.product.id)) issues.push({ kind: "unavailable", lineId: line.id })
    else subtotal += unitPrice * line.quantity
    const media = v.product.media.find(m => m.id === v.mediaId) ?? v.product.media[0]
    return { id: line.id, variantId: v.id, quantity: line.quantity, title: v.product.title, variantTitle: v.title, handle: v.product.handle, imageUrl: media?.url ?? null, unitPrice: { amountPaise: unitPrice, currency: v.currency } }
  })
  // One code per bag, applied to every line counted in the subtotal (owner decision, 25 October 2026:
  // reduced items included). Checked again on every read; a code that stops applying stays on the
  // bag with its reason, so it applies again if the bag qualifies again, until the shopper removes it.
  let promotion: CartView["promotion"] = null
  let discount = 0
  if (cart.promotionId) {
    const { code, decision } = await checkAppliedPromotion(db, { promotionId: cart.promotionId, owner, subtotalPaise: subtotal, now })
    if (code) promotion = decision.ok ? { code, applied: true } : { code, applied: false, reason: decision.reason }
    if (decision.ok) discount = decision.discountPaise
  }
  const inr = (amountPaise: number) => ({ amountPaise, currency: "INR" })
  return { version: 1, id: cart.id, revision: cart.revision, lines: view, subtotal: inr(subtotal), promotion, discount: inr(discount), total: inr(subtotal - discount), issues, expiresAt: cart.expiresAt.toISOString() }
}

/**
 * Runs one change on the owner's cart: locks the row, applies `change`, then bumps the revision.
 * A change that returns "unchanged" (a replayed request) leaves the cart and its revision alone.
 */
async function changeCart(db: Db, owner: Shopper, change: (tx: Tx, cartId: string) => Promise<void | "unchanged">, { create }: { create: boolean }) {
  return db.$transaction(async tx => {
    const now = new Date()
    const found = create ? await openCart(tx, owner, now) : await findCurrentCart(tx, owner, now)
    if (!found) throw notFound()
    const [locked] = await tx.$queryRaw<{ revision: number }[]>`SELECT revision FROM cart WHERE id = ${found.id}::uuid FOR UPDATE`
    if (!locked) throw notFound()
    if ((await change(tx, found.id)) === "unchanged") return (await readCart(tx, owner, now))!
    if (!(await renewCart(tx, owner, found.id, locked.revision, now))) throw new ApiError(409, "conflict", "the bag changed; try again")
    return (await readCart(tx, owner, now))!
  })
}

const quantityOf = (value: unknown, { allowZero }: { allowZero: boolean }) => {
  const min = allowZero ? 0 : 1
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > CART_LIMITS.maxQuantity) {
    throw new ApiError(400, "invalid_request", `quantity must be a whole number from ${min} to ${CART_LIMITS.maxQuantity}`, { quantity: "invalid" })
  }
  return value
}

export type LineToAdd = { variantId: string; quantity: number }

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/

/** The add's Idempotency-Key header: required, so a retried add can never count twice. */
export function addKeyOf(value: unknown) {
  if (value === undefined || value === null || value === "") throw new ApiError(428, "precondition_required", "send an Idempotency-Key header with every add")
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) throw new ApiError(400, "invalid_request", "Idempotency-Key must be 8 to 100 letters, digits, - or _", { "Idempotency-Key": "invalid" })
  return value
}

const available = (b: { onHand: number; reserved: number; allocated: number } | null) => (b ? b.onHand - b.reserved - b.allocated : 0)

/** The add's shape only (no database): a variant id and a quantity within the per-line limit. */
export function parseLineToAdd(body: Record<string, unknown>): LineToAdd {
  const variantId = typeof body.variantId === "string" && UUID.test(body.variantId) ? body.variantId : null
  if (!variantId) throw new ApiError(400, "invalid_request", "variantId must be a variant ID", { variantId: "invalid" })
  const quantity = quantityOf(body.quantity === undefined ? 1 : body.quantity, { allowZero: false })
  return { variantId, quantity }
}

/** The canonical form of an add, stored with its Idempotency-Key ("quantity" missing means 1). */
const requestHash = ({ variantId, quantity }: LineToAdd) => createHash("sha256").update(JSON.stringify({ variantId, quantity })).digest("hex")

/**
 * Whether this add already happened (pre-Stage-12 fix F02): the same Idempotency-Key on the owner's
 * current cart. The same key and body returns the bag as it is now, without writing and without
 * checking stock or publication again (an add that succeeded stays a success when retried, even if
 * the item has since sold out or been taken down); the same key with a different body is refused.
 * Null when the key is new. Keys belong to their cart: once a cart expires, a retry starts afresh.
 */
export async function findAddReplay(db: Db, owner: Shopper | null, key: string, line: LineToAdd) {
  if (!owner) return null
  const cart = await findCurrentCart(db, owner)
  if (!cart) return null
  const earlier = await db.cartRequest.findUnique({ where: { cartId_key: { cartId: cart.id, key } }, select: { requestSha256: true } })
  if (!earlier) return null
  if (earlier.requestSha256 !== requestHash(line)) throw new ApiError(409, "conflict", "this Idempotency-Key was already used for a different add", { "Idempotency-Key": "reused" })
  return readCart(db, owner)
}

const onSale = (db: Db | Tx, variantId: string) =>
  db.productVariant.findFirst({ where: { id: variantId, archivedAt: null, product: PUBLIC_PRODUCT }, select: { balance: { select: { onHand: true, reserved: true, allocated: true } } } })

/**
 * Checks a new add before anything is written, so a refused add starts no guest session: a variant
 * the shop is selling now, and in stock. Anything not on sale is missing. addLine checks both again
 * inside its transaction, so this early check can never let a stale answer through.
 */
export async function checkAddable(db: Db, { variantId }: LineToAdd) {
  const variant = await onSale(db, variantId)
  if (!variant) throw notFound()
  if (available(variant.balance) <= 0) throw new ApiError(409, "conflict", "this item is sold out", { variantId: "sold_out" })
}

/**
 * Adds a checked line to the owner's cart (creating the cart if needed). Quantities add up, capped at
 * the per-line limit, and never above the stock the shop has free right now (read inside the locked
 * change, so it is current). The Idempotency-Key is recorded with the change: the same key again
 * returns the bag unchanged, and the same key with a different request is refused.
 */
export async function addLine(db: Db, owner: Shopper, line: LineToAdd, key: string) {
  const { variantId, quantity } = line
  const requestSha256 = requestHash(line)
  return changeCart(
    db,
    owner,
    async (tx, cartId) => {
      const earlier = await tx.cartRequest.findUnique({ where: { cartId_key: { cartId, key } }, select: { requestSha256: true } })
      if (earlier) {
        if (earlier.requestSha256 !== requestSha256) throw new ApiError(409, "conflict", "this Idempotency-Key was already used for a different add", { "Idempotency-Key": "reused" })
        return "unchanged"
      }
      await tx.cartRequest.create({ data: { cartId, key, requestSha256 } })
      // A new key: every current rule applies, read inside the locked change (on sale, stock, limits).
      const [existing, variant] = await Promise.all([tx.cartLine.findUnique({ where: { cartId_variantId: { cartId, variantId } }, select: { id: true, quantity: true } }), onSale(tx, variantId)])
      if (!variant) throw notFound()
      const total = Math.min(CART_LIMITS.maxQuantity, (existing?.quantity ?? 0) + quantity)
      const free = available(variant?.balance ?? null)
      if (total > free) throw new ApiError(409, "conflict", free <= 0 ? "this item is sold out" : `only ${free} available`, { quantity: "exceeds_stock" })
      if (existing) {
        await tx.cartLine.update({ where: { id: existing.id }, data: { quantity: total } })
        return
      }
      if ((await tx.cartLine.count({ where: { cartId } })) >= CART_LIMITS.maxLines) throw new ApiError(409, "conflict", `a bag holds up to ${CART_LIMITS.maxLines} items`)
      await tx.cartLine.create({ data: { cartId, variantId, quantity } })
    },
    { create: true }
  )
}

/**
 * Sets a line's quantity (0 to the per-line limit); 0 removes it. A line that is not in the owner's
 * live cart is not found. Lowering or removing is always allowed, even for an item no longer on
 * sale; raising needs the item on sale now and enough free stock, read inside the locked change.
 * Setting the same quantity again is a no-op (the revision stays), so a replayed change is harmless.
 */
export async function setLineQuantity(db: Db, owner: Shopper, lineId: string, body: Record<string, unknown>) {
  if (!UUID.test(lineId)) throw notFound()
  const quantity = quantityOf(body.quantity, { allowZero: true })
  return changeCart(
    db,
    owner,
    async (tx, cartId) => {
      const line = await tx.cartLine.findFirst({ where: { id: lineId, cartId, cart: { ...ownedBy(owner), expiresAt: { gt: new Date() } } }, select: { id: true, quantity: true, variantId: true } })
      if (!line) throw notFound()
      if (quantity === line.quantity) return "unchanged"
      if (quantity === 0) {
        await tx.cartLine.delete({ where: { id: line.id } })
        return
      }
      if (quantity > line.quantity) {
        const variant = await tx.productVariant.findFirst({ where: { id: line.variantId, archivedAt: null, product: PUBLIC_PRODUCT }, select: { balance: { select: { onHand: true, reserved: true, allocated: true } } } })
        if (!variant) throw new ApiError(409, "conflict", "this item is no longer available; it can only be removed", { quantity: "unavailable" })
        const free = available(variant.balance)
        if (quantity > free) throw new ApiError(409, "conflict", free <= 0 ? "this item is sold out" : `only ${free} available`, { quantity: "exceeds_stock" })
      }
      await tx.cartLine.update({ where: { id: line.id }, data: { quantity } })
    },
    { create: false }
  )
}

/**
 * Removes one line from the owner's cart. Idempotent: a line that is not in the owner's live cart
 * (already removed, or never theirs) changes nothing and returns the bag as it is, so a repeated
 * removal is harmless and another shopper's line is never touched. Null when the owner has no cart.
 */
export async function removeLine(db: Db, owner: Shopper, lineId: string) {
  if (!UUID.test(lineId)) throw notFound()
  if (!(await findCurrentCart(db, owner))) return null
  return changeCart(
    db,
    owner,
    async (tx, cartId) => {
      const { count } = await tx.cartLine.deleteMany({ where: { id: lineId, cartId, cart: { ...ownedBy(owner), expiresAt: { gt: new Date() } } } })
      return count === 0 ? "unchanged" : undefined
    },
    { create: false }
  )
}

/**
 * Empties the owner's cart. The cart itself, its revision and its add keys stay, so a replayed add
 * from before the clear is still recognised and not applied again. Idempotent: clearing an empty
 * bag changes nothing. Null when the owner has no cart.
 */
export async function clearCart(db: Db, owner: Shopper) {
  if (!(await findCurrentCart(db, owner))) return null
  return changeCart(
    db,
    owner,
    async (tx, cartId) => {
      const { count } = await tx.cartLine.deleteMany({ where: { cartId, cart: { ...ownedBy(owner), expiresAt: { gt: new Date() } } } })
      return count === 0 ? "unchanged" : undefined
    },
    { create: false }
  )
}

/**
 * Applies a promo code to the owner's bag. One code per bag: a valid new code replaces the current
 * one (owner decision, 25 October 2026); a code that does not apply now is refused with its reason
 * and the bag keeps the code it had. Applying the code already on the bag changes nothing.
 */
export async function applyPromotion(db: Db, owner: Shopper, body: Record<string, unknown>) {
  if (!(await findCurrentCart(db, owner))) throw new ApiError(404, "not_found", "add something to the bag first")
  return changeCart(
    db,
    owner,
    async (tx, cartId) => {
      const bag = (await readCart(tx, owner))!
      const decision = await checkPromotion(tx, { code: body.code, owner, subtotalPaise: bag.subtotal.amountPaise })
      if (!decision.ok) throw new ApiError(400, "invalid_request", decision.reason === "not_found" ? "this code is not valid" : `this code cannot be used: ${decision.reason}`, { code: decision.reason })
      const { promotionId } = await tx.cart.findUniqueOrThrow({ where: { id: cartId }, select: { promotionId: true } })
      if (promotionId === decision.promotionId) return "unchanged"
      await tx.cart.update({ where: { id: cartId }, data: { promotionId: decision.promotionId } })
    },
    { create: false }
  )
}

/** Removes the promo code from the owner's bag. Idempotent; null when the owner has no bag. */
export async function removePromotion(db: Db, owner: Shopper) {
  if (!(await findCurrentCart(db, owner))) return null
  return changeCart(
    db,
    owner,
    async (tx, cartId) => {
      const { count } = await tx.cart.updateMany({ where: { id: cartId, promotionId: { not: null } }, data: { promotionId: null } })
      return count === 0 ? "unchanged" : undefined
    },
    { create: false }
  )
}
