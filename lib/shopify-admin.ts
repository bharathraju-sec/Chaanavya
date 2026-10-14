// Server-only Shopify Admin API access, shared by the newsletter signup and the chat's order lookup.
// Credentials come from a Dev Dashboard app installed on this store: SHOPIFY_ADMIN_CLIENT_ID +
// SHOPIFY_ADMIN_CLIENT_SECRET (client credentials grant, 24-hour tokens), or a legacy
// SHOPIFY_ADMIN_ACCESS_TOKEN. Scopes used: write_customers / read_customers (newsletter) and
// read_orders (chat order lookup). Never import this from a client component.

const API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2026-10"
const TIMEOUT_MS = 8000

/** `accessDenied` is true when the app lacks the scope for this query (Shopify ACCESS_DENIED). */
export class ShopifyAdminError extends Error {
  constructor(message: string, readonly accessDenied = false) {
    super(message)
  }
}

function adminConfig() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "")
  const clientId = process.env.SHOPIFY_ADMIN_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET
  const staticToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  if (!domain || !((clientId && clientSecret) || staticToken)) return null
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(domain)) throw new Error("Invalid SHOPIFY_STORE_DOMAIN")
  if (!/^(\d{4}-\d{2}|unstable)$/.test(API_VERSION)) throw new Error("Invalid SHOPIFY_STOREFRONT_API_VERSION")
  return { domain, endpoint: `https://${domain}/admin/api/${API_VERSION}/graphql.json`, clientId, clientSecret, staticToken }
}

export const isAdminConfigured = () => {
  try {
    return adminConfig() !== null
  } catch {
    return false
  }
}

// Client-credentials tokens last 24 hours; reuse one per function instance until shortly before expiry.
let cached: { token: string; expiresAt: number } | null = null

async function accessToken(config: NonNullable<ReturnType<typeof adminConfig>>) {
  if (!(config.clientId && config.clientSecret)) return config.staticToken!
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const response = await fetch(`https://${config.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || typeof payload.access_token !== "string") {
    // Status only: never log credentials or the token response.
    console.error("Shopify Admin token request failed", response.status)
    throw new ShopifyAdminError("Shopify Admin unavailable")
  }
  const lifetimeMs = (Number(payload.expires_in) || 86399) * 1000
  cached = { token: payload.access_token, expiresAt: Date.now() + lifetimeMs - 5 * 60 * 1000 }
  return cached.token
}

/** Runs one Admin GraphQL operation. Logs the HTTP status only, never variables or response bodies. */
export async function shopifyAdmin<T>(query: string, variables: object): Promise<T> {
  const config = adminConfig()
  if (!config) throw new ShopifyAdminError("Shopify Admin not configured")
  const token = await accessToken(config)
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 401) cached = null // revoked or rotated: fetch a fresh token next time
  if (!response.ok || payload.errors) {
    const denied = Array.isArray(payload.errors) && payload.errors.some((e: { extensions?: { code?: string } }) => e?.extensions?.code === "ACCESS_DENIED")
    console.error("Shopify Admin API error", response.status, denied ? "ACCESS_DENIED" : "")
    throw new ShopifyAdminError("Shopify Admin request failed", denied)
  }
  return payload.data as T
}
