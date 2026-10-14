// Server-only: order status for the chat assistant. A customer must give both the order number and
// the email used at checkout; details are shared only when both match, and a mismatch gets the same
// reply as an unknown order, so the tool cannot be used to probe for orders or addresses.
// Needs the read_orders scope on the Shopify Admin app (see lib/shopify-admin.ts).
import { isLikelyEmail } from "@/lib/marketing/welcome-popup"
import { shopifyAdmin, ShopifyAdminError } from "@/lib/shopify-admin"

const WINDOW_MS = 15 * 60 * 1000
const MAX_LOOKUPS = 5
const attempts = new Map<string, { start: number; count: number }>()

/** Best effort, per function instance: at most 5 lookups per visitor every 15 minutes. */
function allowLookup(visitor: string) {
  const now = Date.now()
  if (attempts.size > 5000) for (const [key, entry] of attempts) if (now - entry.start > WINDOW_MS) attempts.delete(key)
  const entry = attempts.get(visitor)
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(visitor, { start: now, count: 1 })
    return true
  }
  entry.count += 1
  return entry.count <= MAX_LOOKUPS
}

type OrderNode = {
  name: string
  email: string | null
  createdAt: string
  cancelledAt: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  lineItems: { nodes: { title: string; quantity: number }[] }
  fulfillments: { displayStatus: string | null; deliveredAt: string | null; estimatedDeliveryAt: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[]
}

const QUERY = `query OrderLookup($query: String!) {
  orders(first: 1, query: $query) {
    nodes {
      name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
      lineItems(first: 10) { nodes { title quantity } }
      fulfillments(first: 5) { displayStatus deliveredAt estimatedDeliveryAt trackingInfo(first: 3) { company number url } }
    }
  }
}`

const NOT_FOUND = "No order matched that order number and email. Ask the customer to check both (the order number is on the confirmation email, like #1001, and the email is the one used at checkout), or send them to /track-order."
const words = (status: string | null) => (status ? status.toLowerCase().replace(/_/g, " ") : "unknown")
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }) : "")

/** Returns a plain-text summary for the model. Never includes addresses, phone numbers or payment details. */
export async function lookupOrder(input: unknown, visitor: string) {
  const { order_number, email } = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const digits = typeof order_number === "string" || typeof order_number === "number" ? String(order_number).replace(/\D/g, "") : ""
  const address = typeof email === "string" ? email.trim().toLowerCase() : ""
  if (!digits || digits.length > 10 || !isLikelyEmail(address)) {
    return "Ask the customer for both their order number (like #1001) and the email used at checkout."
  }
  if (!allowLookup(visitor)) return "Too many order lookups from this visitor. Ask them to wait 15 minutes or use /track-order."

  let order: OrderNode | undefined
  try {
    const data = await shopifyAdmin<{ orders: { nodes: OrderNode[] } }>(QUERY, { query: `name:#${digits}` })
    order = data.orders.nodes[0]
  } catch (error) {
    if (error instanceof ShopifyAdminError && error.accessDenied) console.error("Chat order lookup needs the read_orders scope")
    return "Order lookup is not available right now. Send the customer to /track-order or WhatsApp."
  }
  if (!order || order.name !== `#${digits}` || (order.email || "").toLowerCase() !== address) return NOT_FOUND

  const items = order.lineItems.nodes.map(item => `${item.quantity} x ${item.title}`).join(", ")
  const tracking = order.fulfillments
    .flatMap(f => f.trackingInfo.map(t => [t.company, t.number && `tracking number ${t.number}`, t.url && `tracking link ${t.url}`].filter(Boolean).join(", ")))
    .filter(Boolean)
  const shipment = order.fulfillments
    .map(f => [f.displayStatus && words(f.displayStatus), f.deliveredAt && `delivered ${day(f.deliveredAt)}`, f.estimatedDeliveryAt && `expected ${day(f.estimatedDeliveryAt)}`].filter(Boolean).join(", "))
    .filter(Boolean)

  return [
    `Order ${order.name}, placed ${day(order.createdAt)}.`,
    order.cancelledAt ? `Cancelled on ${day(order.cancelledAt)}.` : "",
    `Payment: ${words(order.displayFinancialStatus)}. Fulfilment: ${words(order.displayFulfillmentStatus)}.`,
    items ? `Items: ${items}.` : "",
    shipment.length ? `Shipment: ${shipment.join("; ")}.` : "Not shipped yet.",
    tracking.length ? `Tracking: ${tracking.join("; ")}.` : "",
    "The full order page is linked in the customer's order confirmation email.",
  ]
    .filter(Boolean)
    .join("\n")
}
