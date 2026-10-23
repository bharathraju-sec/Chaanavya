import type { Money, Product, ProductImage, Variant } from "@/lib/types"
import type { PublicProduct } from "@/lib/catalogue/client"

// Maps a published product from the API (CatalogueProductV1) to the storefront's own Product shape,
// which the cards, pickers and bag already use. Presentation only: no price, stock or visibility
// decision is made here, and nothing is invented (a field the API does not send stays empty).
// `collections` (handles) is set only when the caller resolved the API's collection IDs to handles
// (the product page does, for its breadcrumb and related products).

/** Integer paise to the decimal rupee string the storefront formats (249900 becomes "2499.00"). */
const money = (price: { amountPaise: number; currency: string }): Money => ({ amount: (price.amountPaise / 100).toFixed(2), currencyCode: price.currency })

export function toStorefrontProduct(p: PublicProduct, collectionHandles?: string[]): Product {
  const images: ProductImage[] = p.media.map(m => ({ url: m.url, altText: m.altText, width: m.width, height: m.height }))
  const byId = new Map(p.media.map((m, i) => [m.id, images[i]]))
  const variants: Variant[] = p.variants.map(v => ({
    id: v.id,
    title: v.title,
    availableForSale: v.availableForSale,
    price: money(v.price),
    compareAtPrice: v.compareAtPrice ? money(v.compareAtPrice) : null,
    image: v.mediaId ? (byId.get(v.mediaId) ?? null) : null,
    selectedOptions: v.selectedOptions,
  }))
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    productType: p.productType,
    tags: p.tags,
    featuredImage: images[0] ?? null,
    images,
    variants,
    options: p.options,
    ...(collectionHandles && { collections: collectionHandles }),
  }
}
