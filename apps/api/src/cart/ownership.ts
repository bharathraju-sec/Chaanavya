// Cart ownership and expiry (Stage 11.01). The rules every cart route builds on:
//
// Owner     exactly one: a signed-in customer (user id) or a live guest session (CHECK
//           cart_single_owner). A signed-in shopper always shops as the customer, even if the
//           browser still carries a guest cookie; that guest cart is merged at sign-in (11.0x).
//           The owner comes from the session or the hashed guest cookie, never from the request.
// Access    a cart is found only by its id AND its owner. A different guest, a customer, a staff
//           member, a made-up id, an expired cart or a cart whose guest session expired or was
//           revoked all get the same answer: no cart. Callers answer 404 not_found, so a refusal
//           never tells anyone that the cart exists.
// Expiry    a cart lives CART_LIFETIME.idleDays after its last change and is renewed on every
//           change. A guest cart never outlives its guest session, so it can never be reopened by
//           a cookie the shop has already stopped honouring. An expired cart is read as missing.
// Abandoned a live cart with lines and no change for CART_LIFETIME.abandonedAfterHours. This is a
//           reporting state only: it changes no access and sends nothing (any recovery message
//           needs consent, Stage 18).
// Stock     a cart is an intention, not a claim: nothing here reserves stock (see contracts/cart.ts).
import type { CartId, CustomerId, GuestSessionId, Shopper } from "@chaanavya/contracts/modules/common"
import type { Db, Tx } from "../db/client.ts"

export const CART_LIFETIME = { idleDays: 30, abandonedAfterHours: 24 }

const DAY_MS = 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CartState = "active" | "abandoned" | "expired"

/** The cart owner for a resolved shopper (see resolveShopper): the customer wins over a guest cookie. */
export function cartOwnerOf(shopper: { userId: string | null; guestSessionId: string | null }): Shopper | null {
  if (shopper.userId) return { kind: "customer", customerId: shopper.userId as CustomerId }
  if (shopper.guestSessionId) return { kind: "guest", guestSessionId: shopper.guestSessionId as GuestSessionId }
  return null
}

/** Database filter for "carts this owner may touch". A guest's session must still be live. */
export function ownedBy(owner: Shopper, now = new Date()) {
  if (owner.kind === "customer") return { userId: owner.customerId, guestSessionId: null }
  return { guestSessionId: owner.guestSessionId, userId: null, guestSession: { revokedAt: null, expiresAt: { gt: now } } }
}

/** When a cart changed at `now` expires: idleDays later, never after the guest session ends. */
export function cartExpiry(now: Date, guestSessionExpiresAt?: Date) {
  const idle = new Date(now.getTime() + CART_LIFETIME.idleDays * DAY_MS)
  return guestSessionExpiresAt && guestSessionExpiresAt < idle ? guestSessionExpiresAt : idle
}

export function cartState(cart: { expiresAt: Date; updatedAt: Date; lineCount: number }, now = new Date()): CartState {
  if (cart.expiresAt <= now) return "expired"
  const idleMs = now.getTime() - cart.updatedAt.getTime()
  return cart.lineCount > 0 && idleMs >= CART_LIFETIME.abandonedAfterHours * 60 * 60 * 1000 ? "abandoned" : "active"
}

const CART_FIELDS = { id: true, userId: true, guestSessionId: true, revision: true, expiresAt: true, createdAt: true, updatedAt: true } as const

/** The owner's live cart with this id, or null. Null for every refusal, so callers answer not_found. */
export async function findOwnedCart(db: Db | Tx, owner: Shopper, cartId: string, now = new Date()) {
  if (!UUID.test(cartId)) return null
  return db.cart.findFirst({ where: { id: cartId as CartId, ...ownedBy(owner, now), expiresAt: { gt: now } }, select: CART_FIELDS })
}

/** The owner's newest live cart, or null. */
export async function findCurrentCart(db: Db | Tx, owner: Shopper, now = new Date()) {
  return db.cart.findFirst({ where: { ...ownedBy(owner, now), expiresAt: { gt: now } }, orderBy: { updatedAt: "desc" }, select: CART_FIELDS })
}

/** The owner's current cart, created empty when there is none. A guest needs a live session. */
export async function openCart(db: Db, owner: Shopper, now = new Date()) {
  const current = await findCurrentCart(db, owner, now)
  if (current) return current
  if (owner.kind === "customer") return db.cart.create({ data: { userId: owner.customerId, expiresAt: cartExpiry(now) }, select: CART_FIELDS })
  const session = await db.guestSession.findFirst({ where: { id: owner.guestSessionId, revokedAt: null, expiresAt: { gt: now } }, select: { expiresAt: true } })
  if (!session) return null
  return db.cart.create({ data: { guestSessionId: owner.guestSessionId, expiresAt: cartExpiry(now, session.expiresAt) }, select: CART_FIELDS })
}

/**
 * Records a change to an owned cart: bumps the revision and renews its expiry. Compare-and-set on
 * the revision, so of two writers holding the same revision only one succeeds. Returns false when
 * the cart is not the owner's live cart or the revision moved on.
 */
export async function renewCart(db: Db | Tx, owner: Shopper, cartId: string, revision: number, now = new Date()) {
  if (!UUID.test(cartId)) return false
  let guestExpiresAt: Date | undefined
  if (owner.kind === "guest") {
    const session = await db.guestSession.findFirst({ where: { id: owner.guestSessionId, revokedAt: null, expiresAt: { gt: now } }, select: { expiresAt: true } })
    if (!session) return false
    guestExpiresAt = session.expiresAt
  }
  const { count } = await db.cart.updateMany({
    where: { id: cartId, ...ownedBy(owner, now), expiresAt: { gt: now }, revision },
    data: { revision: { increment: 1 }, expiresAt: cartExpiry(now, guestExpiresAt) },
  })
  return count === 1
}
