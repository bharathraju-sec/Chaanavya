import type { MetadataRoute } from "next"
import { visibleCollections } from "@/lib/collections"
import { getSitemapCatalogue } from "@/lib/catalogue/storefront"

// Lists the home page, the information pages, the collections that have products and every published
// product (Stage 10.11). Products and collections come from the same API reads as the pages (through
// the cached, refreshable catalogue reads), so a draft, an unpublished, archived or uncounted
// product, a collection the owner hid and an empty collection can never appear. When the API cannot
// be reached only the fixed pages are listed. Built per request so it is never frozen at build time.
export const dynamic = "force-dynamic"

const SITE = "https://chaanavya.in"
const PAGES = ["/contact", "/size-guide", "/track-order", "/shipping-policy", "/refund-policy", "/privacy-policy", "/terms"]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const catalogue = await getSitemapCatalogue(visibleCollections.map(c => c.slug))
  return [
    { url: SITE },
    ...catalogue.collections.map(slug => ({ url: `${SITE}/${slug}` })),
    ...catalogue.handles.map(handle => ({ url: `${SITE}/products/${handle}` })),
    ...PAGES.map(path => ({ url: `${SITE}${path}` })),
  ]
}
