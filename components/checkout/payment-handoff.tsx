"use client"

import Link from "next/link"
import { FlaskConical, Lock, TriangleAlert } from "lucide-react"
import * as React from "react"
import type { PlacedOrderV1 } from "@chaanavya/contracts/modules/order"
import type { PaymentSessionV1 } from "@chaanavya/contracts/modules/payment"
import { Button } from "@/components/ui/button"
import { inr } from "@/lib/checkout"
import { PAID_MESSAGE, RAZORPAY_CHECKOUT_SCRIPT, razorpayCheckoutOptions, returnFields, SUBMITTED_MESSAGE, type RazorpayCheckoutOptions } from "@/lib/payment-handoff"

// Pay page (Stage 14.06): hands the shopper's own pending order to Razorpay's checkout. The order and its
// total come from GET /api/cart/order/:id; the checkout from POST /api/cart/order/:id/payment, which takes
// no body, so nothing here can set the amount. Razorpay's window collects every payment detail on
// Razorpay's own host; this page has no payment fields and sends none. What the window reports back is
// shown as a hint only: the order is paid when the API hears it from Razorpay, never because of this page.

type RazorpayInstance = { open(): void; on(event: "payment.failed", handler: () => void): void }
type RazorpayConstructor = new (options: RazorpayCheckoutOptions & { handler: (response: Record<string, unknown>) => void; modal: { ondismiss: () => void } }) => RazorpayInstance
type ReturnView = { outcome: "paid" | "confirming" | "not_paid" }
declare global {
  interface Window {
    Razorpay?: RazorpayConstructor
  }
}

type Answer<T> = { ok: true; data: T } | { ok: false; status: number; message: string; fields: Record<string, string> }

async function call<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  const res = await fetch(`/api/cart/order/${path}`, { cache: "no-store", ...init, headers: { accept: "application/json", ...init?.headers } })
  const body = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; fields?: Record<string, string> } } | null
  if (res.ok) return { ok: true, data: body?.data as T }
  return { ok: false, status: res.status, message: body?.error?.message ?? "", fields: body?.error?.fields ?? {} }
}

/** Loads Razorpay's checkout once, from Razorpay's host. */
function loadCheckout(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay)
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SCRIPT}"]`)
    const script = existing ?? Object.assign(document.createElement("script"), { src: RAZORPAY_CHECKOUT_SCRIPT, async: true })
    script.addEventListener("load", () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error("no checkout"))), { once: true })
    script.addEventListener("error", () => reject(new Error("checkout did not load")), { once: true })
    if (!existing) document.head.appendChild(script)
  })
}

const ORDER_PROBLEM: Record<string, string> = {
  not_pending: "This order can no longer be paid.",
  expired: "The prices for this order have expired. Review your bag again to get a new total.",
  checkout_ended: "This checkout has ended. Review your bag again.",
}

function payProblem(answer: Extract<Answer<unknown>, { ok: false }>) {
  if (answer.status === 503) return "Online payment isn't available right now. Contact us to complete your order."
  if (answer.status === 409 && answer.fields.payment) return "A payment for this order is already in progress. Please wait for it to finish before paying again."
  if (answer.status === 409) return ORDER_PROBLEM[answer.fields.order ?? ""] ?? "This order can no longer be paid."
  if (answer.status === 404) return "We couldn't find this order."
  return "We couldn't open the payment window just now. Please try again."
}

type Phase = "loading" | "ready" | "opening" | "open" | "submitted" | "paid" | "unavailable"

export function PaymentHandoff({ orderId }: { orderId: string }) {
  const [phase, setPhase] = React.useState<Phase>("loading")
  const [order, setOrder] = React.useState<PlacedOrderV1 | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  // One key for this visit; the API also reuses the order's attempt across keys, tabs and retries.
  const key = React.useRef<string | null>(null)

  React.useEffect(() => {
    let live = true
    void call<PlacedOrderV1>(orderId).then(answer => {
      if (!live) return
      if (answer.ok) {
        setOrder(answer.data)
        setPhase("ready")
      } else {
        setMessage(payProblem(answer))
        setPhase("unavailable")
      }
    })
    return () => {
      live = false
    }
  }, [orderId])

  // The window's report goes to the API as an untrusted signal (Stage 14.07); what the page then says comes
  // from the API's answer, never from the report. "Paid" only once the API holds it so.
  async function report(response: Record<string, unknown>) {
    setPhase("submitted")
    const returned = returnFields(response)
    if (!returned) return
    const answer = await call<ReturnView>(`${orderId}/payment/return`, { method: "POST", body: JSON.stringify(returned), headers: { "content-type": "application/json" } })
    if (answer.ok && answer.data.outcome === "paid") setPhase("paid")
  }

  async function pay() {
    setPhase("opening")
    setMessage(null)
    key.current ??= crypto.randomUUID()
    // No body: the API takes the amount from the saved order.
    const started = await call<PaymentSessionV1>(`${orderId}/payment`, { method: "POST", headers: { "idempotency-key": key.current } })
    if (!started.ok) {
      setMessage(payProblem(started))
      setPhase(started.status === 502 ? "ready" : "unavailable")
      return
    }
    const options = razorpayCheckoutOptions(started.data)
    if (!options) {
      setMessage("Online payment isn't available right now. Contact us to complete your order.")
      setPhase("unavailable")
      return
    }
    try {
      const Razorpay = await loadCheckout()
      const checkout = new Razorpay({
        ...options,
        handler: response => void report(response),
        modal: { ondismiss: () => setPhase(current => (current === "submitted" ? current : "ready")) },
      })
      checkout.on("payment.failed", () => setMessage("That payment didn't go through. You can try again, or use another way to pay in the payment window."))
      setPhase("open")
      checkout.open()
    } catch {
      setMessage("The payment window couldn't load. Check your connection and try again.")
      setPhase("ready")
    }
  }

  if (phase === "loading") return <p className="text-muted-foreground" role="status">Loading your order</p>
  if (!order)
    return (
      <div role="alert" className="max-w-xl border border-line-strong bg-sand px-6 py-6">
        <p className="flex items-start gap-2 font-semibold">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-terra" strokeWidth={1.5} aria-hidden />
          {message}
        </p>
        <Button asChild variant="outline" className="mt-5">
          <Link href="/checkout">Back to checkout</Link>
        </Button>
      </div>
    )

  return (
    <section aria-labelledby="pay-heading" className="max-w-xl border border-line bg-card px-5 py-6 sm:px-8">
      <h2 id="pay-heading" className="font-serif text-[28px]">
        Order {order.number}
      </h2>
      {order.test && (
        <p className="mt-4 flex gap-2 border border-dashed border-gold bg-sand px-3 py-2.5 text-xs" data-order="test">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-gold-text" strokeWidth={2} aria-hidden />
          Test order: Razorpay&apos;s sandbox takes no real money.
        </p>
      )}
      <ul className="mt-5 flex flex-col gap-3 border-b border-line pb-5">
        {order.items.map(item => (
          <li key={item.sku} className="flex items-baseline justify-between gap-4 text-sm">
            <span>
              <span className="block font-medium">{item.productTitle}</span>
              <span className="block text-xs text-muted-foreground">
                {item.variantTitle} · {item.quantity}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">{inr(item.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex items-baseline justify-between text-base font-semibold">
        <span>Total</span>
        <span className="tabular-nums" data-total>
          {inr(order.grandTotal)}
        </span>
      </p>

      <div aria-live="polite">
        {phase === "submitted" || phase === "paid" ? (
          <p className="mt-6 border border-line bg-sand px-4 py-3 text-sm" role="status" data-phase={phase}>
            {phase === "paid" ? PAID_MESSAGE : SUBMITTED_MESSAGE}
          </p>
        ) : (
          <>
            <Button className="mt-6 h-13 w-full" onClick={() => void pay()} disabled={phase !== "ready"} data-phase={phase}>
              <Lock strokeWidth={1.5} aria-hidden />
              {phase === "opening" || phase === "open" ? "Opening the payment window" : `Pay ${inr(order.grandTotal)}`}
            </Button>
            {message && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {message}
              </p>
            )}
          </>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">You pay in Razorpay&apos;s secure window. Your card, UPI and bank details go to Razorpay, not to us.</p>
    </section>
  )
}
