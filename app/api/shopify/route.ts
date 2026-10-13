import { NextResponse, type NextRequest } from "next/server"
import { shopifyConfig, storefront, StorefrontError } from "@/lib/shopify"

// Cart operations for the browser. Catalogue reads happen on the server and never pass through here.

const CART_FIELDS = `
  fragment CartFields on Cart {
    id checkoutUrl totalQuantity
    cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
    lines(first: 100) { nodes { id quantity merchandise { ... on ProductVariant { id title availableForSale image { url altText } price { amount currencyCode } product { title handle featuredImage { url altText } } } } } }
  }`

const mutation = (name: string, signature: string, call: string) =>
  `mutation ${name}(${signature}) { ${call} { cart { ...CartFields } userErrors { field message code } warnings { code message target } } } ${CART_FIELDS}`

const operations = {
  cart: `query Cart($id: ID!) { cart(id: $id) { ...CartFields } } ${CART_FIELDS}`,
  cartCreate: mutation("CartCreate", "$input: CartInput!", "cartCreate(input: $input)"),
  cartLinesAdd: mutation("CartLinesAdd", "$cartId: ID!, $lines: [CartLineInput!]!", "cartLinesAdd(cartId: $cartId, lines: $lines)"),
  cartLinesUpdate: mutation("CartLinesUpdate", "$cartId: ID!, $lines: [CartLineUpdateInput!]!", "cartLinesUpdate(cartId: $cartId, lines: $lines)"),
  cartLinesRemove: mutation("CartLinesRemove", "$cartId: ID!, $lineIds: [ID!]!", "cartLinesRemove(cartId: $cartId, lineIds: $lineIds)"),
} as const

type Action = keyof typeof operations

const MAX_BODY_BYTES = 8 * 1024
const MAX_QUANTITY = 99
const MAX_LINES = 20
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX_REQUESTS = 60

// Shopify IDs look like gid://shopify/Cart/abc?key=xyz. Anything else is rejected before it reaches Shopify.
const isGid = (type: string) => (value: unknown): value is string =>
  typeof value === "string" && value.length <= 300 && value.startsWith(`gid://shopify/${type}/`) && !/\s/.test(value)
const isCartId = isGid("Cart")
const isLineId = isGid("CartLine")
const isVariantId = isGid("ProductVariant")
const isQuantity = (value: unknown, min: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= MAX_QUANTITY
const isList = <T,>(value: unknown, check: (item: T) => boolean): value is T[] =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_LINES && value.every(check)

type NewLine = { merchandiseId: string; quantity: number }
type LineUpdate = { id: string; quantity: number }
const isNewLine = (line: NewLine) => isVariantId(line?.merchandiseId) && isQuantity(line.quantity, 1)
const pickNewLine = ({ merchandiseId, quantity }: NewLine) => ({ merchandiseId, quantity })

// Each validator returns a clean copy holding only the expected fields, or null to reject the request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validators: Record<Action, (v: any) => object | null> = {
  cart: ({ id }) => (isCartId(id) ? { id } : null),
  cartCreate: ({ input }) => (isList<NewLine>(input?.lines, isNewLine) ? { input: { lines: input.lines.map(pickNewLine) } } : null),
  cartLinesAdd: ({ cartId, lines }) => (isCartId(cartId) && isList<NewLine>(lines, isNewLine) ? { cartId, lines: lines.map(pickNewLine) } : null),
  cartLinesUpdate: ({ cartId, lines }) =>
    isCartId(cartId) && isList<LineUpdate>(lines, line => isLineId(line?.id) && isQuantity(line.quantity, 0))
      ? { cartId, lines: lines.map(({ id, quantity }) => ({ id, quantity })) }
      : null,
  cartLinesRemove: ({ cartId, lineIds }) => (isCartId(cartId) && isList<string>(lineIds, isLineId) ? { cartId, lineIds } : null),
}

// Best effort: counts live in this function instance's memory, so separate instances count separately.
// The Vercel Firewall rate-limit rule is the hard limit; this stops a single client hammering one instance.
const hits = new Map<string, { start: number; count: number }>()
function retryAfterSeconds(ip: string) {
  const now = Date.now()
  if (hits.size > 5000) {
    for (const [key, entry] of hits) if (now - entry.start > RATE_WINDOW_MS) hits.delete(key)
  }
  const entry = hits.get(ip)
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 })
    return 0
  }
  entry.count += 1
  return entry.count > RATE_MAX_REQUESTS ? Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000) : 0
}

// Vercel overwrites x-forwarded-for at the edge, so clients cannot spoof it.
const clientIp = (request: NextRequest) => (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown"

// Blocks other websites from using this endpoint through their visitors' browsers.
// Non-browser clients can send any headers they like; rate limiting covers them.
function isOwnSite(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite) return fetchSite === "same-origin"
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    const host = new URL(origin).host
    return host === request.headers.get("host") || host === request.headers.get("x-forwarded-host")
  } catch {
    return false
  }
}

const json = (body: object, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })

export async function POST(request: NextRequest) {
  if (!isOwnSite(request)) return json({ error: "Forbidden" }, 403)

  const retryAfter = retryAfterSeconds(clientIp(request))
  if (retryAfter) return json({ error: "Too many requests. Please wait a moment and try again." }, 429, { "Retry-After": String(retryAfter) })

  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Unsupported content type" }, 415)
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413)
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413)

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "Invalid request" }, 400)
  }
  const { action, variables } = (body && typeof body === "object" ? body : {}) as { action?: unknown; variables?: unknown }
  if (typeof action !== "string" || !Object.hasOwn(operations, action)) return json({ error: "Unsupported Shopify operation" }, 400)

  const clean = variables && typeof variables === "object" && !Array.isArray(variables) ? validators[action as Action](variables) : null
  if (!clean) return json({ error: "Invalid request" }, 400)

  try {
    if (!shopifyConfig()) return json({ error: "Store service unavailable" }, 503)
  } catch (error) {
    console.error("Shopify configuration error:", (error as Error).message)
    return json({ error: "Store service unavailable" }, 500)
  }

  try {
    return json(await storefront(operations[action as Action], clean), 200)
  } catch (error) {
    if (!(error instanceof StorefrontError)) console.error("Shopify network error", error)
    return json({ error: "Store service unavailable" }, 502)
  }
}

export function GET() {
  return json({ error: "Method not allowed" }, 405, { Allow: "POST" })
}
