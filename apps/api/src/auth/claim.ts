// Linking a guest order to a customer account (Stage 05). The customer must ask for a specific
// order, be signed in with a verified email equal to the email on that order, and have signed in
// recently. Nothing is linked automatically. Every refusal looks the same ("not_found"), so the
// endpoint cannot be used to discover which order numbers or emails exist.
import type { Db } from "../db/client.ts"
import { recordIdentityEvent } from "./audit.ts"
import type { SignedIn } from "./session.ts"

export const CLAIM_REAUTH_SECONDS = 15 * 60
const ORDER_NUMBER = /^CHV-\d{6,12}$/

export const isRecentSignIn = (signedIn: Pick<SignedIn, "sessionCreatedAt">, now = Date.now()) => now - signedIn.sessionCreatedAt.getTime() <= CLAIM_REAUTH_SECONDS * 1000

export async function claimGuestOrder(database: Db, signedIn: SignedIn, rawOrderNumber: unknown, correlationId: string): Promise<"claimed" | "not_found"> {
  const orderNumber = typeof rawOrderNumber === "string" ? rawOrderNumber.trim().toUpperCase() : ""
  if (!ORDER_NUMBER.test(orderNumber) || !signedIn.emailVerified) return "not_found"
  const email = signedIn.email.toLowerCase()
  return database.$transaction(async tx => {
    const order = await tx.order.findUnique({ where: { number: orderNumber }, select: { id: true, email: true, userId: true } })
    if (!order || order.userId || order.email !== email) return "not_found"
    const { count } = await tx.order.updateMany({ where: { id: order.id, userId: null }, data: { userId: signedIn.userId } })
    if (count !== 1) return "not_found"
    await recordIdentityEvent(tx, {
      action: "order.claimed",
      actor: { kind: "customer", id: signedIn.userId },
      entity: { type: "order", id: order.id },
      reason: "verified_email_match",
      correlationId,
    })
    return "claimed"
  })
}
