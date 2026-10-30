// A pending order bound to its checkout (Stage 13.03). Before anything continues an order (payment,
// in later stages), it is looked up here, and only for the shopper who placed it.
//
// Owner    the order's own guest session or customer, exactly: a customer never reaches a guest's
//          order (even their own from before signing in, until it is claimed), and a guest never
//          reaches another guest's. Every order that is not the shopper's, an unknown id and a
//          malformed id all get the same 404, so order ids cannot be probed.
// Bag      the order names the bag it was placed from; that bag must still be the shopper's and live.
//          A bag that was merged away at sign-in, expired or was deleted ends the checkout (409).
// Window   the order's price is payable until the quote's expiry (payable_until). At or after it the
//          checkout must start again with a new quote (409 expired).
// Status   only a pending_payment order can be continued (409 not_pending otherwise).
// Not here payment itself, stock holds and expiry of unpaid orders (later steps).
import type { Shopper } from "@chaanavya/contracts/modules/common"
import type { PlacedOrderV1 } from "@chaanavya/contracts/modules/order"
import { ApiError, UUID } from "../admin/api.ts"
import { findOwnedCart } from "../cart/ownership.ts"
import type { Db, Tx } from "../db/client.ts"
import { ownerWhere, VIEW, view } from "./intent.ts"

const notFound = () => new ApiError(404, "not_found", "not found")

/** The shopper's own pending order, still inside its payment window, from their own live bag. */
export async function pendingOrderFor(db: Db | Tx, owner: Shopper | null, orderId: string, now = new Date()): Promise<PlacedOrderV1> {
  if (!owner || !UUID.test(orderId)) throw notFound()
  // The owner is part of the lookup itself: a foreign order is never read, so it cannot answer differently.
  const order = await db.order.findFirst({ where: { id: orderId, ...ownerWhere(owner) }, select: { ...VIEW, cartId: true } })
  if (!order || order.quoteRef === null || order.payableUntil === null) throw notFound()
  if (order.status !== "pending_payment") throw new ApiError(409, "conflict", "this order can no longer be paid", { order: "not_pending" })
  if (order.payableUntil.getTime() <= now.getTime()) throw new ApiError(409, "conflict", "this order's prices have expired; review your bag again", { order: "expired" })
  if (!order.cartId || !(await findOwnedCart(db, owner, order.cartId, now))) throw new ApiError(409, "conflict", "this checkout has ended; review your bag again", { order: "checkout_ended" })
  return view(order)
}
