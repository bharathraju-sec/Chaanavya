import type { CollectionId, ContractVersion, LegacyShopifyRef, MediaId, Page, ProductId, Sku, VariantId } from "./common.ts"
import type { MoneyPaise } from "./money.ts"

// Catalogue module: products, variants, collections and media. Authority: Chaanavya database.
// Stock is not stored here; `sellable` is a read-only view
// combining publication status with inventory availability.

export type ProductStatus = "draft" | "active" | "archived"

/** Tax category drives the GST rate and HSN code; values need tax-advisor approval (Stage 12). */
export type TaxCategoryId = string

export type MediaRefV1 = { id: MediaId; url: string; altText: string | null; width: number | null; height: number | null }

export type CatalogueVariantV1 = {
  version: ContractVersion
  id: VariantId
  sku: Sku
  productId: ProductId
  title: string
  selectedOptions: { name: string; value: string }[]
  price: MoneyPaise
  compareAtPrice: MoneyPaise | null
  taxCategory: TaxCategoryId
  mediaId: MediaId | null
  legacy: LegacyShopifyRef
  /** Units available now (counted stock minus holds). Never a count, so stock levels stay private. */
  availableForSale: boolean
}

export type CatalogueProductV1 = {
  version: ContractVersion
  id: ProductId
  /** Public URL handle. Existing handles are preserved across the migration (Stage 01 list). */
  handle: string
  status: ProductStatus
  title: string
  description: string
  productType: string
  tags: string[]
  collectionIds: CollectionId[]
  options: { name: string; values: string[] }[]
  media: MediaRefV1[]
  variants: CatalogueVariantV1[]
  legacy: LegacyShopifyRef
}

export type CollectionV1 = { version: ContractVersion; id: CollectionId; handle: string; title: string; hidden: boolean }

/**
 * Collection page read (Stage 10.05), sent with `page: { nextCursor }`: one visible collection by
 * handle and a page of its published members, newest published first (ties by ID). Hidden and
 * unknown handles are the same 404.
 */
export type CollectionPageV1 = { version: ContractVersion; collection: CollectionV1; products: CatalogueProductV1[] }

/**
 * Product page read (Stage 10.04), sent beside the product (`{ data, selection }`): which variant to
 * show first. `requested` when the shopper's `?variant=` is an active variant of this product,
 * otherwise the first variant that can be bought now, otherwise the first variant. A product with
 * nothing to buy is still found (`availableForSale: false`); missing and hidden are the same 404.
 */
export type ProductSelectionV1 = {
  version: ContractVersion
  selectedVariantId: VariantId
  selectedBy: "requested" | "first_available" | "first"
  /** True when at least one variant can be bought now. */
  availableForSale: boolean
}

// Published-product read projection (Stage 10.02). These lists are the whole public DTO: a field
// not named here never leaves the API, whatever the database row holds. Private by design: stock
// levels, last-counted dates and thresholds; HSN code and weight; shipping restriction; publish
// checklist, approver and approval times; ETag versions; option keys, positions and archive dates;
// storage and staging keys, checksums, byte sizes, content types and old Shopify image URLs.
// Supplier and cost fields do not exist yet; if added, they stay off these lists.
type Exact<T, K extends readonly (keyof T)[]> = [Exclude<keyof T, K[number]>] extends [never] ? K : never
const exact =
  <T>() =>
  <const K extends readonly (keyof T)[]>(keys: Exact<T, K>) =>
    keys

export const PUBLIC_PRODUCT_FIELDS = exact<CatalogueProductV1>()(["version", "id", "handle", "status", "title", "description", "productType", "tags", "collectionIds", "options", "media", "variants", "legacy"])
export const PUBLIC_VARIANT_FIELDS = exact<CatalogueVariantV1>()(["version", "id", "sku", "productId", "title", "selectedOptions", "price", "compareAtPrice", "taxCategory", "mediaId", "legacy", "availableForSale"])
export const PUBLIC_MEDIA_FIELDS = exact<MediaRefV1>()(["id", "url", "altText", "width", "height"])
export const PUBLIC_COLLECTION_PAGE_FIELDS = exact<CollectionPageV1>()(["version", "collection", "products"])
export const PUBLIC_SELECTION_FIELDS =exact<ProductSelectionV1>()(["version", "selectedVariantId", "selectedBy", "availableForSale"])
export const PUBLIC_COLLECTION_FIELDS =exact<CollectionV1>()(["version", "id", "handle", "title", "hidden"])

/**
 * What pricing needs about a variant, read on the server at quote time.
 * Clients never send any of these fields; see invariants.ts `priceLines`.
 */
export type PricingVariantV1 = { variantId: VariantId; sku: Sku; unitPrice: MoneyPaise; taxCategory: TaxCategoryId; sellable: boolean }

export type ProductQueryV1 = { collectionHandle?: string; search?: string; cursor?: string; limit: number }

/** Public reads return active products only; drafts and archived products never reach shoppers. */
export interface CatalogueService {
  getProductByHandle(handle: string, variantId?: VariantId): Promise<{ product: CatalogueProductV1; selection: ProductSelectionV1 } | null>
  listProducts(query: ProductQueryV1): Promise<Page<CatalogueProductV1>>
  listCollections(): Promise<CollectionV1[]>
  getCollectionPage(handle: string, query: { cursor?: string; limit: number }): Promise<{ page: CollectionPageV1; nextCursor: string | null } | null>
  getPricingVariants(ids: VariantId[]): Promise<PricingVariantV1[]>
}
