// Guest-to-customer cart merge at sign-in (Stage 11.08), applying the policy in ./merge.ts in one
// transaction. Called from the sign-in hook (src/auth/server.ts) whenever a session is created and
// the browser still carries a guest cookie.
//
// Locks, always in this order so concurrent sign-ins and cart changes cannot deadlock: the user row
// (so one account merges one guest bag at a time and never gets two carts), the guest session
// (so the same guest bag is merged exactly once), the guest cart, then the account cart (the same
// row lock every cart change takes). The guest session is revoked in the same transaction, so a
// repeated or concurrent merge finds nothing left and quantities are never counted twice.
//
// Promo code (F03): the account bag's own code wins; otherwise the guest bag's code moves over and is
// checked again on every read as the customer. Codes never stack and nothing is counted here.
//
// Ownership stays distinct: lines are copied (variant and quantity only), the guest cart keeps its
// guest owner and is emptied, and the account must be verified and enabled (11.03); otherwise
// nothing is merged and the browser keeps shopping as the guest.
import type { CustomerId, GuestSessionId, Shopper } from "@chaanavya/contracts/modules/common"
import { hashGuestToken } from "../auth/guest.ts"
import { recordIdentityEvent } from "../auth/audit.ts"
import type { Db, Tx } from "../db/client.ts"
import { planMerge } from "./merge.ts"
import { findCurrentCart, openCart, renewCart } from "./ownership.ts"

export type MergeOutcome =
  /** No live guest session for this cookie (missing, made up, expired or already merged). */
  | { status: "no_guest" }
  /** The account is not verified or is disabled: nothing merged, the guest keeps its bag. */
  | { status: "skipped" }
  /** The guest session was ended; `added` new lines, `raised` existing ones, `leftBehind` did not fit. */
  | { status: "merged"; added: number; raised: number; leftBehind: number; promotion: "none" | "carried" | "account_kept" }

const LINE = { id: true, variantId: true, quantity: true, createdAt: true } as const

async function lockCart(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ revision: number }[]>`SELECT revision FROM cart WHERE id = ${id}::uuid FOR UPDATE`
  return row?.revision ?? null
}

/** Merges the guest bag behind `guestToken` into the user's bag, once. */
export async function mergeGuestCart(db: Db, input: { userId: string; guestToken: string; correlationId: string }, now = new Date()): Promise<MergeOutcome> {
  return db.$transaction(async tx => {
    const [user] = await tx.$queryRaw<{ email_verified: boolean; disabled_at: Date | null }[]>`SELECT email_verified, disabled_at FROM "user" WHERE id = ${input.userId}::uuid FOR UPDATE`
    if (!user || !user.email_verified || user.disabled_at) return { status: "skipped" }

    const [guest] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guest_session WHERE token_hash = ${hashGuestToken(input.guestToken)} AND revoked_at IS NULL AND expires_at > ${now} FOR UPDATE`
    if (!guest) return { status: "no_guest" }

    const guestOwner: Shopper = { kind: "guest", guestSessionId: guest.id as GuestSessionId }
    const customer: Shopper = { kind: "customer", customerId: input.userId as CustomerId }
    const guestCart = await findCurrentCart(tx, guestOwner, now)
    if (guestCart) await lockCart(tx, guestCart.id)
    const guestLines = guestCart ? await tx.cartLine.findMany({ where: { cartId: guestCart.id }, select: LINE }) : []

    let added = 0
    let raised = 0
    let leftBehind = 0
    let promotion: "none" | "carried" | "account_kept" = "none"
    let accountCartId: string | null = null
    // Guest lines need an account bag (created if missing); a guest code alone only moves into an
    // account bag that already exists, since an empty new bag would have nothing to discount.
    const account = guestLines.length > 0 ? await openCart(tx, customer, now) : guestCart?.promotionId ? await findCurrentCart(tx, customer, now) : null
    if (guestLines.length > 0 && !account) throw new Error("cart merge: no account cart")
    if (account) {
      accountCartId = account.id
      const revision = await lockCart(tx, account.id)
      if (revision === null) throw new Error("cart merge: account cart vanished")
      let changed = false
      if (guestLines.length > 0) {
        const accountLines = await tx.cartLine.findMany({ where: { cartId: account.id }, select: LINE })
        const plan = planMerge(accountLines, guestLines)
        const existing = new Map(accountLines.map(l => [l.variantId, l]))
        for (const line of plan.lines) {
          const current = existing.get(line.variantId)
          if (!current) {
            await tx.cartLine.create({ data: { cartId: account.id, variantId: line.variantId, quantity: line.quantity } })
            added++
          } else if (current.quantity !== line.quantity) {
            await tx.cartLine.update({ where: { id: current.id }, data: { quantity: line.quantity } })
            raised++
          }
        }
        leftBehind = plan.leftBehind.length
        changed = plan.changesAccount
      }
      // Promo code (pre-Stage-12 fix F03): one code per bag and the account's own code wins;
      // otherwise the guest's code moves over. Nothing is checked or counted here: every read checks
      // the code again as the signed-in customer (their account usage, never the guest session's),
      // so an ineligible code shows with its reason and gives no discount. Read under the lock.
      const { promotionId } = await tx.cart.findUniqueOrThrow({ where: { id: account.id }, select: { promotionId: true } })
      if (guestCart?.promotionId) {
        if (promotionId) promotion = "account_kept"
        else {
          await tx.cart.update({ where: { id: account.id }, data: { promotionId: guestCart.promotionId } })
          promotion = "carried"
          changed = true
        }
      }
      // A carried code alone is a change too, so a quote bound to the old revision goes stale.
      if (changed && !(await renewCart(tx, customer, account.id, revision, now))) throw new Error("cart merge: account cart changed under the lock")
    }

    // The guest bag is emptied and its session ended in the same transaction: nothing can be merged twice.
    if (guestCart) {
      await tx.cartLine.deleteMany({ where: { cartId: guestCart.id } })
      // The guest's contact details (12.04) are not carried: the account has its own email and addresses.
      await tx.cartContact.deleteMany({ where: { cartId: guestCart.id } })
      if (guestCart.promotionId) await tx.cart.update({ where: { id: guestCart.id }, data: { promotionId: null } })
    }
    await tx.guestSession.update({ where: { id: guest.id }, data: { revokedAt: now } })
    await recordIdentityEvent(tx, {
      action: "cart.merged",
      actor: { kind: "customer", id: input.userId },
      entity: { type: "cart", id: accountCartId ?? "none" },
      reason: "sign_in",
      correlationId: input.correlationId,
      after: { added, raised, leftBehind, promotion },
    })
    return { status: "merged", added, raised, leftBehind, promotion }
  })
}
