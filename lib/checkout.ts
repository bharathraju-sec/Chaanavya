// Checkout review (Stage 12.11): when the page is open, and what it shows for a quote. Presentation
// only. Every amount shown is one the API put in the quote (apps/api/src/checkout/quote.ts),
// formatted and nothing else: nothing here adds, subtracts or rounds money, so the total the shopper
// sees is always the API's `grandTotal`.
//
// Open      development and staging only (owner decision, 27 October 2026). In production /checkout
//           is 404 and the bag keeps "Checkout opens soon" until payments exist (Stage 13 onwards).
import type { CheckoutQuoteV1 } from "@chaanavya/contracts/modules/checkout"
import type { MoneyPaise } from "@chaanavya/contracts/modules/money"
import type { ShippingRatesV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import { formatMoney } from "@/lib/types"

type Env = Readonly<Record<string, string | undefined>>

/** The web host's environment, read the same way the API reads it (packages/shared/src/config/env.ts). */
export function environmentOf(env: Env): "development" | "staging" | "production" {
  const declared = env.APP_ENV?.trim()
  if (declared === "development" || declared === "staging" || declared === "production") return declared
  if (env.VERCEL_ENV === "production") return "production"
  if (env.VERCEL_ENV === "preview") return "staging"
  return "development"
}

export const checkoutReviewOpen = (env: Env) => environmentOf(env) !== "production"

/** Paise as rupees for display. A conversion of one server amount, never a sum. */
export const inr = (m: MoneyPaise) => formatMoney(m.amountPaise / 100)

export type ReviewRow = { label: string; amount: string; note?: string }
export type ReviewSummary = {
  lines: { key: string; title: string; detail: string; quantity: number; unitPrice: string; lineTotal: string }[]
  rows: ReviewRow[]
  total: string
  taxNote: string
  delivery: string
  test: string | null
  expiresAt: string
}

const TEST_REASON: Record<CheckoutQuoteV1["testReasons"][number], string> = {
  test_shipping_rates: "delivery uses test rates from a sandbox courier",
  tax_profile_unapproved: "GST uses a draft tax profile that is not approved",
}

const days = (n: number | null) => (n === null ? null : n === 1 ? "about 1 day" : `about ${n} days`)
const time = new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" })

/** What the review shows for a quote: each figure straight from the quote. */
export function reviewSummary(quote: CheckoutQuoteV1): ReviewSummary {
  const rows: ReviewRow[] = [{ label: "Subtotal", amount: inr(quote.subtotal) }]
  if (quote.discountTotal.amountPaise > 0) rows.push({ label: "Discount", amount: `minus ${inr(quote.discountTotal)}` })
  rows.push({ label: "Delivery", amount: inr(quote.shipping.total), note: quote.shipping.courierName })
  rows.push({ label: quote.pricesIncludeTax ? "GST included" : "GST", amount: inr(quote.taxTotal) })
  const test = quote.mode === "test" ? `Test quote: ${quote.testReasons.map(r => TEST_REASON[r]).join(", and ")}. Nothing can be ordered at these prices.` : null
  return {
    lines: quote.lines.map(l => ({ key: `${l.variantId}`, title: l.title, detail: l.variantTitle, quantity: l.quantity, unitPrice: inr(l.unitPrice), lineTotal: inr(l.lineTotal) })),
    rows,
    total: inr(quote.grandTotal),
    taxNote: quote.pricesIncludeTax ? "Prices include GST." : "GST is added to the prices shown.",
    delivery: [quote.shipping.courierName, days(quote.shipping.estimatedDeliveryDays)].filter(Boolean).join(", "),
    test,
    expiresAt: time.format(new Date(quote.expiresAt)),
  }
}

/** Indian states and union territories (ISO 3166-2:IN). The API checks the code; this is only the picker. */
export const STATE_OPTIONS: readonly (readonly [string, string])[] = [
  ["IN-AN", "Andaman and Nicobar Islands"],
  ["IN-AP", "Andhra Pradesh"],
  ["IN-AR", "Arunachal Pradesh"],
  ["IN-AS", "Assam"],
  ["IN-BR", "Bihar"],
  ["IN-CH", "Chandigarh"],
  ["IN-CG", "Chhattisgarh"],
  ["IN-DH", "Dadra and Nagar Haveli and Daman and Diu"],
  ["IN-DL", "Delhi"],
  ["IN-GA", "Goa"],
  ["IN-GJ", "Gujarat"],
  ["IN-HR", "Haryana"],
  ["IN-HP", "Himachal Pradesh"],
  ["IN-JK", "Jammu and Kashmir"],
  ["IN-JH", "Jharkhand"],
  ["IN-KA", "Karnataka"],
  ["IN-KL", "Kerala"],
  ["IN-LA", "Ladakh"],
  ["IN-LD", "Lakshadweep"],
  ["IN-MP", "Madhya Pradesh"],
  ["IN-MH", "Maharashtra"],
  ["IN-MN", "Manipur"],
  ["IN-ML", "Meghalaya"],
  ["IN-MZ", "Mizoram"],
  ["IN-NL", "Nagaland"],
  ["IN-OD", "Odisha"],
  ["IN-PY", "Puducherry"],
  ["IN-PB", "Punjab"],
  ["IN-RJ", "Rajasthan"],
  ["IN-SK", "Sikkim"],
  ["IN-TN", "Tamil Nadu"],
  ["IN-TG", "Telangana"],
  ["IN-TR", "Tripura"],
  ["IN-UP", "Uttar Pradesh"],
  ["IN-UK", "Uttarakhand"],
  ["IN-WB", "West Bengal"],
]

// Delivery failures (Stage 12.12). When delivery is not available, the review says why, offers what
// the shopper can do, and shows no total: checkout cannot go on. A courier that could not be reached
// is never shown as delivering, nor as refusing: it is "could not check", with a retry.

export type DeliveryAction = "change_address" | "retry" | "edit_bag" | "contact"
export type DeliveryIssue = {
  kind: "pin_unserviceable" | "category_restricted" | "parcel_unsupported" | "provider_unavailable" | "no_courier"
  title: string
  detail: string
  actions: DeliveryAction[]
}

/** What blocks delivery for this bag and address, from the API's answers; null when nothing does. */
export function deliveryIssue(rates: ShippingRatesV1 | null, quoteError: { fields: Record<string, string> } | null): DeliveryIssue | null {
  const pin = rates?.delivery.pinCode || "this PIN code"
  const shippingRefusal = quoteError?.fields.shipping ?? null
  const reason = rates?.quote?.status === "unavailable" ? rates.quote.reason : shippingRefusal
  if (rates?.mode === "none" || shippingRefusal === "no_courier")
    return { kind: "no_courier", title: "Delivery isn't available yet", detail: "Online delivery is still being set up. Contact us and we'll arrange your order.", actions: ["contact"] }
  if (!rates || reason === "provider_unavailable" || (rates.delivery.delivery === "unknown" && rates.delivery.source !== "none"))
    return {
      kind: "provider_unavailable",
      title: `We couldn't check delivery to ${pin} just now`,
      detail: "The courier didn't answer. This doesn't tell us whether we can deliver there, so try again in a moment.",
      actions: ["retry", "contact"],
    }
  if (rates.delivery.delivery === "not_serviceable" || reason === "pin_unserviceable")
    return { kind: "pin_unserviceable", title: `We don't deliver to ${pin} yet`, detail: "Check the PIN code, or use another delivery address.", actions: ["change_address", "contact"] }
  if (reason === "category_restricted") {
    const titles = (rates.restrictedItems ?? []).map(i => i.title)
    const named = titles.length === 0 ? null : titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`
    return {
      kind: "category_restricted",
      title: named ? `We can't send ${named} to ${pin}` : `Something in your bag can't be sent to ${pin}`,
      detail: named
        ? `The couriers that serve this address don't carry ${titles.length === 1 ? "it" : "them"}. Remove ${titles.length === 1 ? "it" : "them"} from your bag, or use another address.`
        : "The couriers that serve this address don't carry one of your items, such as perfume. Remove it from your bag, or use another address.",
      actions: ["edit_bag", "change_address"],
    }
  }
  if (reason === "parcel_unsupported")
    return { kind: "parcel_unsupported", title: "We can't price delivery for this bag yet", detail: "Contact us and we'll arrange delivery for your order.", actions: ["contact", "edit_bag"] }
  return null
}

/** Checkout can go on only with a quote from the API and nothing blocking delivery. */
export const canProceed = (quote: CheckoutQuoteV1 | null, issue: DeliveryIssue | null) => quote !== null && issue === null
