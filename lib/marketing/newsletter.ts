// Server-only: newsletter signups are stored as Shopify customers with email-marketing consent,
// so the store's own email marketing (Shopify Email) can reach them. Admin access (credentials,
// tokens) lives in lib/shopify-admin.ts. Never import this from a client component.
import { isAdminConfigured, shopifyAdmin } from "@/lib/shopify-admin"

export class NewsletterError extends Error {}

export const isNewsletterConfigured = isAdminConfigured

async function admin<T>(query: string, variables: object): Promise<T> {
  try {
    return await shopifyAdmin<T>(query, variables)
  } catch {
    throw new NewsletterError("Newsletter provider unavailable")
  }
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
