import { fallbackProducts } from "./catalog"
import type { Product, Variant } from "./types"

// Server-side Storefront API access. Never import this from a client component:
// it reads the storefront token from the environment.

const API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2026-10"
const SHOPIFY_TIMEOUT_MS = 8000
const CATALOG_REVALIDATE_SECONDS = 300

type StoreConfig = { endpoint: string; headers: Record<string, string> }

export function shopifyConfig(): StoreConfig | null {
  // Mock catalogue is for local testing only and can never be switched on in production.
  if (process.env.SHOPIFY_USE_MOCK === "true" && process.env.VERCEL_ENV !== "production") {
    return { endpoint: `https://mock.shop/api/${API_VERSION}/graphql.json`, headers: {} }
  }

  const domain = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "")
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN
  if (!domain || !token) return null
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(domain)) throw new Error("Invalid SHOPIFY_STORE_DOMAIN")
  if (!/^(\d{4}-\d{2}|unstable)$/.test(API_VERSION)) throw new Error("Invalid SHOPIFY_STOREFRONT_API_VERSION")

  return {
    endpoint: `https://${domain}/api/${API_VERSION}/graphql.json`,
    headers: { "X-Shopify-Storefront-Access-Token": token },
  }
}

export const isStoreLive = () => {
  try {
    return shopifyConfig() !== null
  } catch {
    return false
  }
}

export class StorefrontError extends Error {}

/** Runs one Storefront API operation. `revalidate` caches the response (catalogue reads only). */
export async function storefront<T>(query: string, variables: object, revalidate?: number): Promise<T> {
  const config = shopifyConfig()
  if (!config) throw new StorefrontError("Store service unavailable")

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...config.headers },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    ...(revalidate ? { cache: "force-cache" as const, next: { revalidate, tags: ["catalog"] } } : { cache: "no-store" as const }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.errors) {
    console.error("Shopify Storefront API error", payload.errors || response.status)
    throw new StorefrontError("Store service unavailable")
  }
  return payload.data as T
}

const PRODUCT_FIELDS = `
  id
  handle
  title
  description
  productType
  tags
  featuredImage { url altText width height }
  images(first: 8) { nodes { url altText width height } }
  options(first: 3) { name optionValues { name } }
  variants(first: 30) {
    nodes {
      id
      title
      availableForSale
      image { url altText width height }
      price { amount currencyCode }
      selectedOptions { name value }
    }
  }
`

type RawProduct = Omit<Product, "images" | "variants" | "options"> & {
  images: { nodes: Product["images"] }
  variants: { nodes: Variant[] }
  options: { name: string; optionValues: { name: string }[] }[]
}

const normalize = (raw: RawProduct): Product => ({
  ...raw,
  images: raw.images?.nodes ?? [],
  variants: raw.variants?.nodes ?? [],
  options: (raw.options ?? []).map(o => ({ name: o.name, values: o.optionValues.map(v => v.name) })),
})

// Demonstration products are for local and preview builds only. On the production deployment a
// missing or failing Shopify connection shows "store unavailable" instead of placeholder merchandise.
const demoAllowed = () => process.env.VERCEL_ENV !== "production"

export type Catalog = { products: Product[]; live: boolean; unavailable: boolean }

const offline = (): Catalog => (demoAllowed() ? { products: fallbackProducts, live: false, unavailable: false } : { products: [], live: false, unavailable: true })

/** Newest products first. Without Shopify: demo catalogue outside production, empty and `unavailable` in production. */
export async function getProducts(): Promise<Catalog> {
  if (!isStoreLive()) return offline()
  try {
    const data = await storefront<{ products: { nodes: RawProduct[] } }>(
      `query Products($first: Int!) { products(first: $first, sortKey: CREATED_AT, reverse: true) { nodes { ${PRODUCT_FIELDS} } } }`,
      { first: 50 },
      CATALOG_REVALIDATE_SECONDS
    )
    return { products: data.products.nodes.map(normalize), live: true, unavailable: false }
  } catch {
    return offline()
  }
}

/** One product. Throws StorefrontError in production when Shopify is unreachable (rendered by app/error.tsx). */
export async function getProduct(handle: string): Promise<{ product: Product | null; live: boolean }> {
  if (!/^[a-z0-9][a-z0-9-]{0,254}$/i.test(handle)) return { product: null, live: isStoreLive() }
  const demo = () => {
    if (!demoAllowed()) throw new StorefrontError("Store service unavailable")
    return { product: fallbackProducts.find(p => p.handle === handle) ?? null, live: false }
  }
  if (!isStoreLive()) return demo()
  try {
    const data = await storefront<{ product: RawProduct | null }>(
      `query Product($handle: String!) { product(handle: $handle) { ${PRODUCT_FIELDS} } }`,
      { handle },
      CATALOG_REVALIDATE_SECONDS
    )
    return { product: data.product ? normalize(data.product) : null, live: true }
  } catch {
    return demo()
  }
}
