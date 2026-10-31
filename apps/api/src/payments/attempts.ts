// Payment attempts (Stage 14.03): one logical attempt to pay for an order, with one stable identity. An
// attempt records the amount and currency (the order's own total, read here on the server, never from the
// browser), the order it pays for, the provider and mode, the provider's references once known, its state
// and the idempotency key it was opened with.
//
// Identity  an order has at most one attempt in progress (created, authorized or waiting for its outcome),
//           enforced by the database (migration 20261031000000_payment_attempt_identity). Opening again,
//           with the same key or another one, returns that attempt; only after it ends (captured, failed,
//           expired) can a new one start. The same key never names a different order's attempt.
// Fixed     the database refuses any change to an attempt's order, provider, mode, amount, currency, key or
//           creation time, refuses to replace a provider reference once written, and never deletes one.
// Moves     the attempt's state moves only through transitionPayment (apps/api/src/db/transitions.ts).
import { PAYMENT_PROVIDERS } from "@chaanavya/contracts/modules/state-machines"
import { ApiError } from "../admin/api.ts"
import type { Db, Tx } from "../db/client.ts"
import type { PaymentProvider } from "../db/generated/enums.ts"
import { toPaise } from "../db/money.ts"
import { isDuplicateKey } from "../inventory/ledger.ts"

export const OPEN_ATTEMPT_STATUSES = ["created", "authorized", "pending_reconciliation"] as const
const KEY = /^[A-Za-z0-9_-]{8,100}$/
const isLaunched = (provider: string): provider is PaymentProvider => (PAYMENT_PROVIDERS as readonly string[]).includes(provider)

type Row = { id: string; orderId: string; provider: string; mode: string; amountPaise: bigint; currency: string; providerOrderId: string | null; providerPaymentId: string | null; status: string; idempotencyKey: string; createdAt: Date; updatedAt: Date }

export const attemptView = (a: Row) => ({
  id: a.id,
  orderId: a.orderId,
  provider: a.provider,
  mode: a.mode,
  amount: { amountPaise: toPaise(a.amountPaise), currency: a.currency },
  providerOrderId: a.providerOrderId,
  providerPaymentId: a.providerPaymentId,
  status: a.status,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
})
export type AttemptView = ReturnType<typeof attemptView>

/** The stored key: the caller's key scoped to its order, so one order's key can never find another's attempt. */
export const attemptKey = (orderId: string, key: string) => `order:${orderId}:${key}`

export type OpenAttemptInput = { orderId: string; provider: string; mode: "test" | "live"; key: string; now?: Date }

/**
 * Opens the order's payment attempt, or returns the one already in progress. `reused` says whether this call
 * found an existing attempt (a retry, a second tab) instead of creating one.
 */
export async function openAttempt(db: Db, input: OpenAttemptInput): Promise<{ attempt: AttemptView; reused: boolean }> {
  if (!KEY.test(input.key)) throw new ApiError(400, "invalid_request", "Idempotency-Key must be 8 to 100 letters, digits, - or _", { "Idempotency-Key": "invalid" })
  const provider = input.provider
  if (!isLaunched(provider)) throw new ApiError(409, "conflict", "this payment provider is not switched on")
  const stored = attemptKey(input.orderId, input.key)
  try {
    return await db.$transaction(async tx => {
      // FOR NO KEY UPDATE: inserting the attempt takes a KEY SHARE lock on the order, which this must not block.
      const [order] = await tx.$queryRaw<{ status: string; payable_until: Date | null; grand_total_paise: bigint; currency: string }[]>`
        SELECT status::text AS status, payable_until, grand_total_paise, currency FROM "order" WHERE id = ${input.orderId}::uuid FOR NO KEY UPDATE`
      if (!order) throw new ApiError(404, "not_found", "not found")

      const same = await tx.paymentAttempt.findUnique({ where: { idempotencyKey: stored } })
      if (same) return { attempt: attemptView(same), reused: true }

      if (order.status !== "pending_payment") throw new ApiError(409, "conflict", "this order is not waiting for payment")
      if (order.payable_until && order.payable_until.getTime() <= (input.now ?? new Date()).getTime()) throw new ApiError(409, "conflict", "the payment window for this order has ended")

      const open = await tx.paymentAttempt.findFirst({ where: { orderId: input.orderId, status: { in: [...OPEN_ATTEMPT_STATUSES] } } })
      if (open) return { attempt: attemptView(open), reused: true }

      const created = await tx.paymentAttempt.create({
        data: { orderId: input.orderId, provider, mode: input.mode, amountPaise: order.grand_total_paise, currency: order.currency, idempotencyKey: stored },
      })
      return { attempt: attemptView(created), reused: false }
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    // Another request opened it at the same moment: its attempt is this one.
    const winner = (await db.paymentAttempt.findUnique({ where: { idempotencyKey: stored } })) ?? (await db.paymentAttempt.findFirst({ where: { orderId: input.orderId, status: { in: [...OPEN_ATTEMPT_STATUSES] } } }))
    if (!winner) throw error
    return { attempt: attemptView(winner), reused: true }
  }
}

/**
 * Records the provider's reference for the attempt's checkout, once. The same reference again is a no-op; a
 * different one is refused, here and by the database.
 */
export async function recordProviderOrderRef(db: Db | Tx, attemptId: string, providerOrderId: string) {
  if (!providerOrderId.trim()) throw new ApiError(400, "invalid_request", "a provider reference is required")
  await db.paymentAttempt.updateMany({ where: { id: attemptId, providerOrderId: null }, data: { providerOrderId } })
  const attempt = await db.paymentAttempt.findUnique({ where: { id: attemptId } })
  if (!attempt) throw new ApiError(404, "not_found", "not found")
  if (attempt.providerOrderId !== providerOrderId) throw new ApiError(409, "conflict", "this attempt already has a different provider reference")
  return attemptView(attempt)
}
