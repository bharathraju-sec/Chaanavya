"use client"

import Link from "next/link"
import { ArrowRight, FlaskConical, Lock, RotateCw, TriangleAlert } from "lucide-react"
import * as React from "react"
import type { CheckoutContactV1, CheckoutQuoteV1, IndianAddressV1 } from "@chaanavya/contracts/modules/checkout"
import type { ShippingRatesV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import { useCart } from "@/components/cart/cart-provider"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { canProceed, deliveryIssue, reviewSummary, STATE_OPTIONS, type DeliveryIssue } from "@/lib/checkout"
import { describeShipping, TEST_BADGE } from "@/lib/shipping-rates"

// Checkout review (Stage 12.11): delivery address, delivery option and the order summary, all from
// the API. The address is saved with PUT /api/cart/contact; delivery options come from
// /api/cart/shipping-rates; the summary is the quote from POST /api/cart/quote, shown as the API
// priced it (lib/checkout.ts formats it and does no arithmetic). Nothing here places an order.
// When delivery is not available (Stage 12.12) the delivery section says why and what to do, and the
// summary shows no total: checkout cannot go on until delivery is sorted.

const field = "h-12 w-full border border-line-strong bg-paper px-3.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-ink aria-[invalid=true]:border-destructive"

type ApiError = { message: string; fields: Record<string, string> }
type Answer<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError }

async function call<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  const res = await fetch(`/api/cart${path}`, { cache: "no-store", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } })
  const body = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; fields?: Record<string, string> } } | null
  if (res.ok) return { ok: true, data: body?.data as T }
  return { ok: false, status: res.status, error: { message: body?.error?.message ?? "Something went wrong. Please try again.", fields: body?.error?.fields ?? {} } }
}

type Bag = { revision: number; lines: unknown[] }
type Draft = Omit<IndianAddressV1, "country" | "line2" | "landmark"> & { line2: string; landmark: string; email: string }

const EMPTY: Draft = { email: "", name: "", phone: "", line1: "", line2: "", landmark: "", city: "", district: "", stateCode: "", pinCode: "" }

const QUOTE_PROBLEM: Record<string, string> = {
  insufficient_stock: "Some items no longer have enough stock. Change the quantities in your bag.",
  unavailable: "Some items are no longer available. Remove them from your bag.",
  pin_unserviceable: "We can't deliver to this PIN code yet. Try another address.",
  category_restricted: "Something in your bag can't be sent to this address by the available couriers.",
  parcel_unsupported: "We can't price delivery for this bag yet. Contact us to order.",
  provider_unavailable: "Delivery options could not be loaded. Try again shortly.",
  no_courier: "Delivery isn't available yet. Contact us to order.",
  no_active_profile: "Checkout isn't open yet. Contact us to order.",
}

function quoteProblem(error: ApiError) {
  for (const value of Object.values(error.fields)) if (QUOTE_PROBLEM[value]) return QUOTE_PROBLEM[value]
  return error.message.charAt(0).toUpperCase() + error.message.slice(1) + "."
}

export function CheckoutReview() {
  const { lines: bagLines, setOpen: openBag } = useCart()
  const bagKey = bagLines.map(l => `${l.id}:${l.quantity}`).join(",")
  const [state, setState] = React.useState<"loading" | "empty" | "ready">("loading")
  const [bag, setBag] = React.useState<Bag | null>(null)
  const [contact, setContact] = React.useState<CheckoutContactV1 | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [rates, setRates] = React.useState<ShippingRatesV1 | null>(null)
  const [serviceRef, setServiceRef] = React.useState<string | null>(null)
  const [quote, setQuote] = React.useState<CheckoutQuoteV1 | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [quoteError, setQuoteError] = React.useState<ApiError | null>(null)
  const [pricing, setPricing] = React.useState(false)
  // The delivery choice, kept for re-pricing after a bag change; a new choice re-prices through choose().
  const choice = React.useRef<string | null>(null)

  const price = React.useCallback(async (revision: number, pick: string | null) => {
    setPricing(true)
    setProblem(null)
    setQuoteError(null)
    try {
      const shipping = await call<ShippingRatesV1>("/shipping-rates")
      setRates(shipping.ok ? shipping.data : null)
      const priced = await call<CheckoutQuoteV1>("/quote", { method: "POST", body: JSON.stringify({ serviceRef: pick, cartRevision: revision }) })
      if (priced.ok) {
        setQuote(priced.data)
        setServiceRef(priced.data.shipping.serviceRef)
        choice.current = priced.data.shipping.serviceRef
      } else {
        setQuote(null)
        setQuoteError(priced.error)
        setProblem(quoteProblem(priced.error))
      }
    } finally {
      setPricing(false)
    }
  }, [])

  // Shows the bag as the API has it now, then prices it if a delivery address is saved.
  const apply = React.useCallback(
    async (cart: Answer<Bag | null>, saved: Answer<CheckoutContactV1 | null>, pick: string | null) => {
      const current = cart.ok ? cart.data : null
      if (!current || current.lines.length === 0) {
        setState("empty")
        return
      }
      setBag(current)
      const known = saved.ok ? saved.data : null
      setContact(known)
      setEditing(!known)
      setState("ready")
      if (known) await price(current.revision, pick)
      else setQuote(null)
    },
    [price],
  )

  React.useEffect(() => {
    let live = true
    Promise.all([call<Bag | null>(""), call<CheckoutContactV1 | null>("/contact")]).then(([cart, saved]) => {
      if (live) void apply(cart, saved, choice.current)
    })
    return () => {
      live = false
    }
  }, [apply, bagKey])

  async function choose(ref: string) {
    setServiceRef(ref)
    choice.current = ref
    if (bag) await price(bag.revision, ref)
  }

  if (state === "loading") return <p className="text-muted-foreground" role="status">Loading your bag</p>
  if (state === "empty")
    return (
      <div className="max-w-xl border border-line bg-card px-6 py-8">
        <p className="font-serif text-2xl">Your bag is empty</p>
        <p className="mt-2 text-sm text-muted-foreground">Add something to your bag, then come back to review your order.</p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/">Continue shopping</Link>
        </Button>
      </div>
    )

  const shipping = describeShipping(rates)
  const options = rates?.quote?.status === "available" ? rates.quote.options : []
  const issue = contact && !pricing ? deliveryIssue(rates, quoteError) : null
  const proceed = canProceed(quote, issue)
  const summary = quote && proceed ? reviewSummary(quote) : null
  const act = (action: DeliveryIssue["actions"][number]) => {
    if (action === "change_address") setEditing(true)
    else if (action === "retry" && bag) void price(bag.revision, choice.current)
    else if (action === "edit_bag") openBag(true)
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-14">
      <div className="flex flex-col gap-10">
        <section aria-labelledby="address-heading" className="border border-line bg-card px-5 py-6 sm:px-8">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="address-heading" className="font-serif text-[28px]">
              Delivery address
            </h2>
            {contact && !editing && (
              <Button variant="link" onClick={() => setEditing(true)}>
                Change
              </Button>
            )}
          </div>
          {editing || !contact ? (
            <AddressForm
              initial={contact}
              onCancel={contact ? () => setEditing(false) : undefined}
              onSaved={async saved => {
                setContact(saved)
                setEditing(false)
                if (bag) await price(bag.revision, serviceRef)
              }}
            />
          ) : (
            <AddressCard contact={contact} />
          )}
        </section>

        <section aria-labelledby="delivery-heading" className="border border-line bg-card px-5 py-6 sm:px-8">
          <div className="flex items-center justify-between gap-3">
            <h2 id="delivery-heading" className="font-serif text-[28px]">
              Delivery option
            </h2>
            {shipping.kind === "test" && (
              <span className="inline-flex items-center gap-1 rounded-full border border-gold px-2 py-0.5 text-[11px] font-semibold tracking-wide text-gold-text uppercase">
                <FlaskConical className="size-3" strokeWidth={2} aria-hidden />
                {TEST_BADGE}
              </span>
            )}
          </div>
          {!contact ? (
            <p className="mt-3 text-sm text-muted-foreground">Add a delivery address to see delivery options.</p>
          ) : issue ? (
            <IssueCard issue={issue} busy={pricing} onAction={act} />
          ) : shipping.kind === "hidden" ? (
            <p className="mt-3 text-sm text-muted-foreground">Delivery isn&apos;t available yet.</p>
          ) : (
            <>
              {shipping.notice && <p className="mt-2 text-xs text-muted-foreground">{shipping.notice}</p>}
              {options.length === 0 ? (
                <p className="mt-3 text-sm">{shipping.unavailable}</p>
              ) : (
                <fieldset className="mt-4" disabled={pricing}>
                  <legend className="sr-only">Choose a delivery option</legend>
                  <div className="flex flex-col divide-y divide-line border-y border-line">
                    {shipping.rows.map(row => (
                      <label key={row.key} className="flex min-h-14 cursor-pointer items-center gap-3 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-terra">
                        <input type="radio" name="delivery" value={row.key} checked={serviceRef === row.key} onChange={() => void choose(row.key)} className="size-4 accent-terra" />
                        <span className="flex-1">
                          <span className="block text-sm font-medium">{row.label}</span>
                          {row.detail && <span className="block text-xs text-muted-foreground">{row.detail}</span>}
                        </span>
                        <span className="text-sm tabular-nums">
                          {row.testRate && <span className="mr-1.5 text-[11px] font-semibold text-gold-text uppercase">Test rate</span>}
                          {row.price}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </>
          )}
        </section>
      </div>

      <aside aria-labelledby="summary-heading" className="h-fit border border-line bg-card px-5 py-6 sm:px-8 lg:sticky lg:top-28">
        <h2 id="summary-heading" className="font-serif text-[28px]">
          Order summary
        </h2>
        {summary ? (
          <div aria-live="polite" aria-busy={pricing}>
            {summary.test && (
              <p className="mt-4 flex gap-2 border border-dashed border-gold bg-sand px-3 py-2.5 text-xs" data-quote="test">
                <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-gold-text" strokeWidth={2} aria-hidden />
                {summary.test}
              </p>
            )}
            <ul className="mt-5 flex flex-col gap-3 border-b border-line pb-5">
              {summary.lines.map(line => (
                <li key={line.key} className="flex items-baseline justify-between gap-4 text-sm">
                  <span>
                    <span className="block font-medium">{line.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {line.detail} · {line.quantity} × {line.unitPrice}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{line.lineTotal}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-4 flex flex-col gap-2 text-sm">
              {summary.rows.map(row => (
                <div key={row.label} className="flex items-baseline justify-between gap-4">
                  <dt>
                    {row.label}
                    {row.note && <span className="block text-xs text-muted-foreground">{row.note}</span>}
                  </dt>
                  <dd className="tabular-nums">{row.amount}</dd>
                </div>
              ))}
              <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-line pt-3 text-base">
                <dt className="font-semibold">Total</dt>
                <dd className="font-semibold tabular-nums" data-total>
                  {summary.total}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              {summary.taxNote} Delivery: {summary.delivery}. These prices are held until {summary.expiresAt}.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" role={problem && !issue ? "alert" : undefined}>
            {pricing ? "Working out your total" : issue ? "Your total appears once delivery is available for this address." : (problem ?? "Add a delivery address to see your total.")}
          </p>
        )}
        {/* Placeholder: payment arrives in Stage 13; nothing here places an order. Without a quote and
            available delivery (proceed false) checkout cannot go on, whatever payment adds later. */}
        <Button className="mt-6 h-13 w-full" disabled data-can-proceed={proceed ? "yes" : "no"}>
          <Lock strokeWidth={1.5} aria-hidden />
          Payment opens soon
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          Online payment is being set up. To order now,{" "}
          <Link href="/contact" className="underline underline-offset-4 hover:text-terra">
            contact us
          </Link>
          .
        </p>
      </aside>
    </div>
  )
}

const ACTION_LABEL: Record<DeliveryIssue["actions"][number], string> = {
  change_address: "Change address",
  retry: "Try again",
  edit_bag: "Edit bag",
  contact: "Contact us",
}

function IssueCard({ issue, busy, onAction }: { issue: DeliveryIssue; busy: boolean; onAction: (a: DeliveryIssue["actions"][number]) => void }) {
  return (
    <div role="alert" data-issue={issue.kind} className="mt-4 border border-line-strong bg-sand px-4 py-4">
      <p className="flex items-start gap-2 text-sm font-semibold">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-terra" strokeWidth={1.5} aria-hidden />
        {issue.title}
      </p>
      <p className="mt-1 pl-6 text-sm text-muted-foreground">{issue.detail}</p>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 pl-6">
        {issue.actions.map(action =>
          action === "contact" ? (
            <Button key={action} asChild variant="link">
              <Link href="/contact">{ACTION_LABEL[action]}</Link>
            </Button>
          ) : (
            <Button key={action} variant="link" disabled={busy} onClick={() => onAction(action)}>
              {action === "retry" && <RotateCw strokeWidth={1.5} aria-hidden />}
              {ACTION_LABEL[action]}
            </Button>
          ),
        )}
      </div>
    </div>
  )
}

function AddressCard({ contact }: { contact: CheckoutContactV1 }) {
  const a = contact.shippingAddress
  const state = STATE_OPTIONS.find(([code]) => code === a.stateCode)?.[1] ?? a.stateCode
  return (
    <address className="mt-3 text-sm leading-relaxed not-italic">
      <span className="block font-medium">{a.name}</span>
      <span className="block">{[a.line1, a.line2].filter(Boolean).join(", ")}</span>
      {a.landmark && <span className="block">Near {a.landmark}</span>}
      <span className="block">
        {a.city}, {a.district}, {state} {a.pinCode}
      </span>
      <span className="mt-2 block text-muted-foreground">
        {a.phone} · {contact.email}
      </span>
    </address>
  )
}

const FIELDS: { key: keyof Draft; label: string; autoComplete: string; type?: string; inputMode?: "numeric" | "tel" | "email"; optional?: boolean; wide?: boolean }[] = [
  { key: "email", label: "Email for order updates", autoComplete: "email", type: "email", inputMode: "email", wide: true },
  { key: "name", label: "Full name", autoComplete: "name", wide: true },
  { key: "phone", label: "Mobile number", autoComplete: "tel", type: "tel", inputMode: "tel" },
  { key: "pinCode", label: "PIN code", autoComplete: "postal-code", inputMode: "numeric" },
  { key: "line1", label: "House, building, street", autoComplete: "address-line1", wide: true },
  { key: "line2", label: "Area, locality", autoComplete: "address-line2", optional: true, wide: true },
  { key: "landmark", label: "Landmark", autoComplete: "off", optional: true },
  { key: "city", label: "City or town", autoComplete: "address-level2" },
  { key: "district", label: "District", autoComplete: "off" },
]

/** Field-specific wording for an "invalid" answer from the API. */
const INVALID_TEXT: Partial<Record<keyof Draft, string>> = {
  email: "Check the email address",
  phone: "Enter a 10-digit Indian mobile number",
  pinCode: "Enter the 6-digit PIN code",
  stateCode: "Choose a state or union territory",
}

const problemText = (key: keyof Draft, problem: string) => (problem === "invalid" && INVALID_TEXT[key]) || PROBLEM_TEXT[problem] || "Check this"

const PROBLEM_TEXT: Record<string, string> = {
  required: "Required",
  invalid: "Check this",
  too_long: "Too long",
  account_email: "Order emails go to your account email",
}

function AddressForm({ initial, onSaved, onCancel }: { initial: CheckoutContactV1 | null; onSaved: (c: CheckoutContactV1) => void; onCancel?: () => void }) {
  const a = initial?.shippingAddress
  const [draft, setDraft] = React.useState<Draft>(a ? { ...a, line2: a.line2 ?? "", landmark: a.landmark ?? "", email: initial.email } : EMPTY)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [message, setMessage] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const { email, ...address } = draft
      const saved = await call<CheckoutContactV1>("/contact", {
        method: "PUT",
        body: JSON.stringify({ email, shippingAddress: { ...address, line2: address.line2 || null, landmark: address.landmark || null } }),
      })
      if (saved.ok) {
        setErrors({})
        onSaved(saved.data)
        return
      }
      const fields: Record<string, string> = {}
      for (const [key, problem] of Object.entries(saved.error.fields)) fields[key.replace(/^shippingAddress\./, "")] = problem
      setErrors(fields)
      setMessage(saved.status === 400 ? "Check the highlighted fields." : saved.error.message)
    } finally {
      setBusy(false)
    }
  }

  const input = (f: (typeof FIELDS)[number]) => {
    const id = `checkout-${f.key}`
    const problem = errors[f.key]
    return (
      <div key={f.key} className={`flex flex-col gap-2 ${f.wide ? "sm:col-span-2" : ""}`}>
        <Label htmlFor={id}>
          {f.label}
          {f.optional && <span className="font-normal text-muted-foreground"> (optional)</span>}
        </Label>
        <input
          id={id}
          type={f.type ?? "text"}
          inputMode={f.inputMode}
          autoComplete={f.autoComplete}
          required={!f.optional}
          value={draft[f.key]}
          onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
          className={field}
        />
        {problem && (
          <p id={`${id}-error`} className="text-xs text-destructive">
            {problemText(f.key, problem)}
          </p>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="mt-5 grid gap-5 sm:grid-cols-2">
      {FIELDS.map(input)}
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor="checkout-stateCode">State or union territory</Label>
        <select
          id="checkout-stateCode"
          required
          autoComplete="address-level1"
          value={draft.stateCode}
          onChange={e => setDraft(d => ({ ...d, stateCode: e.target.value }))}
          aria-invalid={errors.stateCode ? true : undefined}
          aria-describedby={errors.stateCode ? "checkout-stateCode-error" : undefined}
          className={field}
        >
          <option value="">Choose</option>
          {STATE_OPTIONS.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        {errors.stateCode && (
          <p id="checkout-stateCode-error" className="text-xs text-destructive">
            {problemText("stateCode", errors.stateCode)}
          </p>
        )}
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving" : "Use this address"}
          <ArrowRight strokeWidth={1.5} aria-hidden />
        </Button>
        {onCancel && (
          <Button type="button" variant="link" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
