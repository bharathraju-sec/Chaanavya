import { fallbackProducts } from "@/lib/catalog"
import { isHiddenProduct } from "@/lib/collections"
import { getCollectionPage, getProductPage, listCollections, listProducts } from "@/lib/catalogue/client"
import { toStorefrontProduct } from "@/lib/catalogue/map"
import type { Product } from "@/lib/types"

// Storefront catalogue reads. The homepage and the header search read published products from the
// NestJS API through lib/catalogue/client.ts (Stage 10.07), and so do the collection pages (10.08)
// and the product pages (10.09); none of them falls back to the placeholder catalogue in lib/catalog.ts
// (template products, placeholder names and prices), which only the hidden shop chat still reads;
// checkout stays closed.

export type Catalog = { products: Product[]; unavailable: boolean }

const visible = () => fallbackProducts.filter(p => !isHiddenProduct(p))

/** Published products from the API, newest first. `unavailable` is true only when the API could not be reached or understood; an empty shop is a normal answer. */
async function fromApi(limit: number): Promise<Catalog> {
  const result = await listProducts({ limit })
  return result.status === "ok" ? { products: result.data.products.map(p => toStorefrontProduct(p)), unavailable: false } : { products: [], unavailable: result.status === "unavailable" }
}

/** One page of a collection page's products. `found: false` is a missing or hidden collection (or a malformed cursor); `unavailable` is an outage. */
export type CollectionView = { found: false } | { found: true; products: Product[]; nextCursor: string | null; unavailable: boolean }

export const COLLECTION_PAGE_SIZE = 48

/**
 * The products on a storefront collection page (Stage 10.08). `new-arrivals` is not a collection in
 * the database: it is the newest published products across the shop. Every other slug is the
 * collection's handle, read through the collection API, so the owner hiding it hides the page.
 */
export async function getCollectionProducts(slug: string, cursor?: string | null): Promise<CollectionView> {
  const options = { limit: COLLECTION_PAGE_SIZE, cursor }
  const result = slug === "new-arrivals" ? await listProducts(options) : await getCollectionPage(slug, options)
  if (result.status === "not_found") return { found: false }
  if (result.status === "unavailable") return { found: true, products: [], nextCursor: null, unavailable: true }
  return { found: true, products: result.data.products.map(p => toStorefrontProduct(p)), nextCursor: result.data.nextCursor, unavailable: false }
}

/** The homepage's "New this week" products. */
export const getNewArrivals = (limit = 4) => fromApi(limit)

/** Products offered by the header search (the newest 48). */
export async function getSearchProducts(): Promise<Product[]> {
  return (await fromApi(48)).products
}

/** Placeholder catalogue, newest first. Only the hidden shop chat reads it, until Stage 18.09 moves it to the API. */
export async function getProducts(): Promise<Catalog> {
  return { products: visible(), unavailable: false }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ProductView = { found: false } | { found: true; unavailable: true } | { found: true; unavailable: false; product: Product; selectedVariantId: string; selectedBy: "requested" | "first_available" | "first" }

/**
 * One product page's data (Stage 10.09): the published product by handle, with the variant the API
 * says to show first (`variantId` is the shopper's choice from a link). A missing or hidden product
 * is `found: false` (the same answer for both); an outage is `unavailable`. The API's collection IDs
 * are resolved to handles for the breadcrumb and related products.
 */
export async function getProductView(handle: string, variantId?: string | null): Promise<ProductView> {
  // A variant that is not a variant ID is ignored (the API ignores one that is not this product's).
  const requested = variantId && UUID.test(variantId) ? variantId : null
  const [result, collections] = await Promise.all([getProductPage(handle, requested), listCollections()])
  if (result.status === "not_found") return { found: false }
  if (result.status === "unavailable") return { found: true, unavailable: true }
  const handles = collections.status === "ok" ? new Map(collections.data.map(c => [c.id, c.handle])) : new Map<string, string>()
  const own = result.data.product.collectionIds.flatMap(id => handles.get(id) ?? [])
  const { selectedVariantId, selectedBy } = result.data.selection
  return { found: true, unavailable: false, product: toStorefrontProduct(result.data.product, own), selectedVariantId, selectedBy }
}

export type SitemapCatalogue = { available: boolean; handles: string[]; collections: string[] }

const SITEMAP_PAGE = 48
/** A safety bound (4,800 products); the sitemap format allows 50,000 URLs and the shop is far smaller. */
const SITEMAP_MAX_PAGES = 100

/**
 * What the sitemap may list (Stage 10.11), from the same API reads as the pages, so it can only name
 * published, counted products and collections shoppers can open. `available: false` means the API
 * could not be reached: the sitemap then lists static pages only rather than guess. Empty
 * collections are left out (they are not indexed either). `new-arrivals` is listed once any product
 * is published.
 */
export async function getSitemapCatalogue(configuredSlugs: string[]): Promise<SitemapCatalogue> {
  const handles: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < SITEMAP_MAX_PAGES; page++) {
    const result = await listProducts({ limit: SITEMAP_PAGE, cursor })
    if (result.status !== "ok") return { available: false, handles: [], collections: [] }
    handles.push(...result.data.products.map(p => p.handle))
    cursor = result.data.nextCursor
    if (!cursor) break
  }
  const visible = await listCollections()
  if (visible.status !== "ok") return { available: false, handles: [], collections: [] }
  const open = new Set(visible.data.map(c => c.handle))
  const collections: string[] = []
  for (const slug of configuredSlugs) {
    if (slug === "new-arrivals") {
      if (handles.length > 0) collections.push(slug)
    } else if (open.has(slug)) {
      const first = await getCollectionPage(slug, { limit: 1 })
      if (first.status === "ok" && first.data.products.length > 0) collections.push(slug)
    }
  }
  return { available: true, handles, collections }
}
