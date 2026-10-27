// Cart ownership and expiry (Stage 11.01). The rules every cart route builds on:
//
// Owner     exactly one: a signed-in customer (user id) or a live guest session (CHECK
//           cart_single_owner). A signed-in shopper always shops as the customer, even if the
//           browser still carries a guest cookie; that guest cart is merged at sign-in (11.0x).
//           Only a verified, enabled account owns a cart (11.03): a signed-in user whose email is
//           not verified shops as a guest, and a disabled account's carts are unreachable. Both
//           are checked in the database filter too, not only when the owner is worked out.
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

/** The cart owner for a resolved shopper (see resolveShopper): a verified customer wins over a guest cookie. */
export function cartOwnerOf(shopper: { userId: string | null; emailVerified: boolean; guestSessionId: string | null }): Shopper | null {
  if (shopper.userId && shopper.emailVerified === true) return { kind: "customer", customerId: shopper.userId as CustomerId }
  if (shopper.guestSessionId) return { kind: "guest", guestSessionId: shopper.guestSessionId as GuestSessionId }
  return null
}

/** Database filter for "carts this owner may touch". A guest's session must still be live. */
export function ownedBy(owner: Shopper, now = new Date()) {
  if (owner.kind === "customer") return { userId: owner.customerId, guestSessionId: null, user: { emailVerified: true, disabledAt: null } }
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

const CART_FIELDS = { id: true, userId: true, guestSessionId: true, revision: true, promotionId: true, expiresAt: true, createdAt: true, updatedAt: true } as const

/** The owner's live cart with this id, or null. Null for every refusal, so callers answer not_found. */
export async function findOwnedCart(db: Db | Tx, owner: Shopper, cartId: string, now = new Date()) {
  if (!UUID.test(cartId)) return null
  return db.cart.findFirst({ where: { id: cartId as CartId, ...ownedBy(owner, now), expiresAt: { gt: now } }, select: CART_FIELDS })
}

/** The owner's newest live cart, or null. */
export async function findCurrentCart(db: Db | Tx, owner: Shopper, now = new Date()) {
  return db.cart.findFirst({ where: { ...ownedBy(owner, now), expiresAt: { gt: now } }, orderBy: { updatedAt: "desc" }, select: CART_FIELDS })
}

/**
 * The owner's current cart, created empty when there is none. A customer must be verified and
 * enabled; a guest needs a live session; otherwise null.
 *
 * At most one live cart per owner (pre-Stage-12 fix F01): the owner's own row (the user, or the
 * guest session) is locked FOR UPDATE before looking for a cart, so two first adds at once queue
 * and the second finds the cart the first created. A lock on the cart row cannot do this, because
 * there is no cart row yet. Must run inside a transaction for the lock to hold; every writer
 * (changeCart, mergeGuestCart) does, and takes the owner lock first, so the lock order is
 * owner, then cart. Expired carts are left as they are (history; the purge job removes them) and a
 * new one is created beside them; only live carts count.
 */
export async function openCart(db: Db | Tx, owner: Shopper, now = new Date()) {
  const lock = await lockCartOwner(db, owner, now)
  if (!lock) return null
  const guestExpiresAt = lock.guestExpiresAt
  const current = await findCurrentCart(db, owner, now)
  if (current) return current
  if (owner.kind === "customer") return db.cart.create({ data: { userId: owner.customerId, expiresAt: cartExpiry(now) }, select: CART_FIELDS })
  return db.cart.create({ data: { guestSessionId: owner.guestSessionId, expiresAt: cartExpiry(now, guestExpiresAt) }, select: CART_FIELDS })
}

/**
 * Locks the owner's own row FOR UPDATE (the user, or the guest session): the first lock every cart
 * writer takes (F01). Null when the owner may not hold a cart: an unverified or disabled customer, or
 * a guest session that ended. Inside a transaction only.
 */
export async function lockCartOwner(db: Db | Tx, owner: Shopper, now = new Date()): Promise<{ guestExpiresAt: Date | undefined } | null> {
  if (owner.kind === "customer") {
    const [user] = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT (email_verified AND disabled_at IS NULL) AS ok FROM "user" WHERE id = ${owner.customerId}::uuid FOR UPDATE`
    return user?.ok ? { guestExpiresAt: undefined } : null
  }
  const [session] = await db.$queryRaw<{ expires_at: Date }[]>`
    SELECT expires_at FROM guest_session WHERE id = ${owner.guestSessionId}::uuid AND revoked_at IS NULL AND expires_at > ${now} FOR UPDATE`
  return session ? { guestExpiresAt: session.expires_at } : null
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
