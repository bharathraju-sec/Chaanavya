// Hosted checkout hand-off (Stage 14.06): how the pay page passes a pending order to Razorpay's own
// checkout. Presentation only. The API opened the Razorpay order for the saved total (Stage 14.04); this
// hands Razorpay's Standard Checkout (checkout.js, loaded from Razorpay) the public key ID and that order's
// id, and nothing else. The buyer types card, UPI or bank details into Razorpay's window, which is
// Razorpay's own frame on Razorpay's host: they never pass through this page, the web host or the API.
//
// Trust   nothing the checkout reports back is believed here. Its "done" only means the buyer finished in
//         Razorpay's window; whether money was taken is decided by the API from Razorpay itself (later
//         Stage 14 steps). Nothing here records a payment or changes an order.
// Hosts   the pay page alone may load Razorpay (proxy.ts); every other page keeps the strict policy.
import type { PaymentSessionV1 } from "@chaanavya/contracts/modules/payment"

/** Razorpay's Standard Checkout, loaded only from Razorpay's own host. */
export const RAZORPAY_CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js"

/** What the pay page lets Razorpay's checkout reach (Razorpay's published hosts for Standard Checkout). */
export const RAZORPAY_CHECKOUT_HOSTS = {
  script: ["https://checkout.razorpay.com"],
  frame: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  connect: ["https://api.razorpay.com", "https://lumberjack.razorpay.com"],
  img: ["https://cdn.razorpay.com"],
} as const

/** The pay page for one order: /checkout/pay/<order id>. */
export const PAY_PATH = /^\/checkout\/pay\/[0-9a-f-]{36}\/?$/i
export const isPayPath = (path: string) => PAY_PATH.test(path)
export const payPath = (orderId: string) => `/checkout/pay/${orderId}`

/** Exactly what Razorpay's checkout is given: public values only, never a secret or anything of the buyer's. */
export type RazorpayCheckoutOptions = {
  key: string
  order_id: string
  amount: number
  currency: "INR"
  name: string
  description: string
}

/**
 * Razorpay checkout options from the API's payment session, or null when the session is not one this page
 * can open. Only the named public values are copied; anything else in the session is dropped. The key must
 * be a test key (live waits for the legal gate, packages/shared/src/config/payments-gate.ts), and the
 * Razorpay order and amount must agree with the session the API returned.
 */
export function razorpayCheckoutOptions(session: PaymentSessionV1): RazorpayCheckoutOptions | null {
  if (session.provider !== "razorpay" || session.next.kind !== "embedded") return null
  const p = session.next.publicParams
  if (!/^rzp_test_[A-Za-z0-9]+$/.test(p.key ?? "")) return null
  if (!/^order_[A-Za-z0-9]+$/.test(p.order_id ?? "") || p.order_id !== session.providerOrderId) return null
  if (session.amount.currency !== "INR" || p.currency !== "INR" || p.amount !== String(session.amount.amountPaise)) return null
  return { key: p.key, order_id: p.order_id, amount: session.amount.amountPaise, currency: "INR", name: p.name ?? "Chaanavya", description: p.description ?? "" }
}

/** The fields of Razorpay's checkout report the page passes on to the API (Stage 14.07); nothing else. */
const RETURN_FIELDS = ["razorpay_payment_id", "razorpay_order_id", "razorpay_signature"] as const

/** Razorpay's report, reduced to its three string fields; null when one is missing. */
export function returnFields(response: Record<string, unknown>): Record<(typeof RETURN_FIELDS)[number], string> | null {
  const picked = Object.fromEntries(RETURN_FIELDS.map(name => [name, response[name]]))
  return RETURN_FIELDS.every(name => typeof picked[name] === "string") ? (picked as Record<(typeof RETURN_FIELDS)[number], string>) : null
}

/** What the page says once the API holds the order as paid (never because the window said so). */
export const PAID_MESSAGE = "Payment received. Thank you, your order is confirmed."

/** What the page says once the buyer finishes in Razorpay's window: a hint, never a payment status. */
export const SUBMITTED_MESSAGE = "Thank you. We're confirming your payment with Razorpay, and your order updates once they confirm it. Please don't pay again."
