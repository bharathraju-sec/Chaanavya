// Server-only: newsletter signups are stored as Shopify customers with email-marketing consent,
// so the store's own email marketing (Shopify Email) can reach them. Credentials come from a
// Dev Dashboard app with write_customers and read_customers scopes, installed on this store:
// SHOPIFY_ADMIN_CLIENT_ID + SHOPIFY_ADMIN_CLIENT_SECRET (client credentials grant, 24-hour tokens),
// or a legacy SHOPIFY_ADMIN_ACCESS_TOKEN. Never import this from a client component.

const API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2026-10"
const TIMEOUT_MS = 8000

export class NewsletterError extends Error {}

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
    throw new NewsletterError("Newsletter provider unavailable")
  }
  const lifetimeMs = (Number(payload.expires_in) || 86399) * 1000
  cached = { token: payload.access_token, expiresAt: Date.now() + lifetimeMs - 5 * 60 * 1000 }
  return cached.token
}

export const isNewsletterConfigured = () => {
  try {
    return adminConfig() !== null
  } catch {
    return false
  }
}

async function admin<T>(query: string, variables: object): Promise<T> {
  const config = adminConfig()
  if (!config) throw new NewsletterError("Newsletter not configured")
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
    // Status only: never log the email address or provider response bodies.
    console.error("Shopify Admin API newsletter error", response.status)
    throw new NewsletterError("Newsletter provider unavailable")
  }
  return payload.data as T
}

type UserError = { field?: string[] | null; message: string }

/**
 * Subscribes an email. New addresses become a Shopify customer tagged "newsletter" and the
 * campaign; existing customers get their email-marketing consent updated. Both resolve the same
 * way so the response never reveals whether an address was already known.
 */
export async function subscribeEmail(email: string, campaign: string) {
  const consent = { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN", consentUpdatedAt: new Date().toISOString() }

  const created = await admin<{ customerCreate: { customer: { id: string } | null; userErrors: UserError[] } }>(
    `mutation Subscribe($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
    { input: { email, emailMarketingConsent: consent, tags: ["newsletter", campaign] } }
  )
  if (created.customerCreate.customer) return

  const taken = created.customerCreate.userErrors.some(e => e.field?.includes("email") && /taken|already/i.test(e.message))
  if (!taken) throw new NewsletterError("Subscription rejected")

  // Email passed isLikelyEmail (no quotes or spaces), so it is safe inside the search string.
  const found = await admin<{ customers: { nodes: { id: string }[] } }>(
    `query FindCustomer($query: String!) { customers(first: 1, query: $query) { nodes { id } } }`,
    { query: `email:"${email}"` }
  )
  const customerId = found.customers.nodes[0]?.id
  if (!customerId) throw new NewsletterError("Subscription rejected")

  const updated = await admin<{ customerEmailMarketingConsentUpdate: { userErrors: UserError[] } }>(
    `mutation Consent($input: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } } }`,
    { input: { customerId, emailMarketingConsent: consent } }
  )
  // Shopify reports an error when the address is already subscribed; treat that as success.
  const errors = updated.customerEmailMarketingConsentUpdate.userErrors.filter(e => !/already/i.test(e.message))
  if (errors.length) throw new NewsletterError("Subscription rejected")
}
