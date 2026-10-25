// Public catalogue reads (Stage 08; the storefront switches to them in Stage 10). Shoppers only ever
// see active products, their active variants, approved photos that were not removed, and collections
// that are not hidden. Since Stage 09 a live product is shown only once every one of its variants
// has been counted in an approved stocktake, and each variant says whether it can be bought now.
// Everything else reads exactly like a missing product.
import type { CatalogueProductV1, CollectionPageV1, CollectionV1, ProductSelectionV1 } from "@chaanavya/contracts/modules/catalogue"
import type { CollectionId, MediaId, ProductId, Sku, VariantId } from "@chaanavya/contracts/modules/common"
import { Prisma } from "../db/generated/client.ts"
import { encodeCursor } from "../admin/api.ts"
import type { Db } from "../db/client.ts"
import { toPaise } from "../db/money.ts"
import { productOptions } from "./products.ts"

// The publication filter, applied inside every public query (Stage 10.03): live and published by an
// owner (publishedAt is set by the publish action), with every active variant counted.
export const PUBLIC_PRODUCT = {
  status: "active",
  publishedAt: { not: null },
  variants: { some: { archivedAt: null }, every: { OR: [{ archivedAt: { not: null } }, { balance: { lastCountedAt: { not: null } } }] } },
} satisfies Prisma.ProductWhereInput

const INCLUDE = {
  variants: { where: { archivedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: { balance: { select: { onHand: true, reserved: true, allocated: true } } } },
  media: { where: { status: "approved", removedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
  collections: { where: { collection: { hidden: false } }, select: { collectionId: true } },
} satisfies Prisma.ProductInclude

type Row = Prisma.ProductGetPayload<{ include: typeof INCLUDE }>

// The database is the authority for these IDs; brand them where they leave it.
const as = <T extends string>(value: string) => value as T

const currency = (code: string) => code as CatalogueProductV1["variants"][number]["price"]["currency"]

function toPublic(p: Row): CatalogueProductV1 {
  return {
    version: 1,
    id: as<ProductId>(p.id),
    handle: p.handle,
    status: "active",
    title: p.title,
    description: p.description,
    productType: p.productType,
    tags: p.tags,
    collectionIds: p.collections.map(c => as<CollectionId>(c.collectionId)),
    options: productOptions(p.variants),
    media: p.media.map(m => ({ id: as<MediaId>(m.id), url: m.url!, altText: m.altText, width: m.width, height: m.height })),
    variants: p.variants.map(v => ({
      version: 1,
      id: as<VariantId>(v.id),
      sku: as<Sku>(v.sku),
      productId: as<ProductId>(p.id),
      title: v.title,
      selectedOptions: Array.isArray(v.selectedOptions) ? (v.selectedOptions as { name: string; value: string }[]) : [],
      price: { amountPaise: toPaise(v.pricePaise), currency: currency(v.currency) },
      compareAtPrice: v.compareAtPricePaise === null ? null : { amountPaise: toPaise(v.compareAtPricePaise), currency: currency(v.currency) },
      taxCategory: v.taxCategory,
      mediaId: v.mediaId && p.media.some(m => m.id === v.mediaId) ? as<MediaId>(v.mediaId) : null,
      legacy: v.legacyShopifyGid ? { shopifyGid: v.legacyShopifyGid } : null,
      availableForSale: v.balance !== null && v.balance.onHand - v.balance.reserved - v.balance.allocated > 0,
    })),
    legacy: p.legacyShopifyGid ? { shopifyGid: p.legacyShopifyGid } : null,
  }
}

export async function publicProduct(db: Db, handle: string) {
  const row = await db.product.findFirst({ where: { ...PUBLIC_PRODUCT, handle }, include: INCLUDE })
  return row ? toPublic(row) : null
}

/** Why a handle is not public. Only the server log sees this; shoppers get the same 404 for all. */
export type NotPublicReason = "missing" | "draft" | "archived" | "not_published" | "not_counted" | "no_variants"

export type ProductPage = { found: true; product: CatalogueProductV1; selection: ProductSelectionV1 } | { found: false; reason: NotPublicReason }

/**
 * The product page read (Stage 10.04): a published product by handle and the variant to show first.
 * Missing and hidden handles are told apart for the log only; a published product with nothing to
 * buy is found, with `availableForSale: false`.
 */
export async function publicProductPage(db: Db, handle: string, requestedVariantId: string | null): Promise<ProductPage> {
  const product = await publicProduct(db, handle)
  if (!product) return { found: false, reason: await notPublicReason(db, handle) }
  const requested = requestedVariantId ? product.variants.find(v => v.id === requestedVariantId) : undefined
  const available = product.variants.find(v => v.availableForSale)
  const [selected, selectedBy] = requested ? [requested, "requested" as const] : available ? [available, "first_available" as const] : [product.variants[0], "first" as const]
  return { found: true, product, selection: { version: 1, selectedVariantId: selected.id, selectedBy, availableForSale: available !== undefined } }
}

async function notPublicReason(db: Db, handle: string): Promise<NotPublicReason> {
  const row = await db.product.findUnique({ where: { handle }, select: { status: true, publishedAt: true, variants: { where: { archivedAt: null }, select: { balance: { select: { lastCountedAt: true } } } } } })
  if (!row) return "missing"
  if (row.status !== "active") return row.status
  if (!row.publishedAt) return "not_published"
  if (row.variants.length === 0) return "no_variants"
  return "not_counted"
}

export async function publicProducts(db: Db, q: { collectionHandle: string | null; limit: number; after: { publishedAt: string; id: string } | null }) {
  const filters: Prisma.ProductWhereInput[] = [PUBLIC_PRODUCT]
  if (q.collectionHandle) filters.push({ collections: { some: { collection: { handle: q.collectionHandle, hidden: false } } } })
  if (q.after) filters.push({ OR: [{ publishedAt: { lt: new Date(q.after.publishedAt) } }, { publishedAt: new Date(q.after.publishedAt), id: { lt: q.after.id } }] })
  const rows = await db.product.findMany({ where: { AND: filters }, include: INCLUDE, orderBy: [{ publishedAt: "desc" }, { id: "desc" }], take: q.limit + 1 })
  const last = rows.length > q.limit ? rows[q.limit - 1] : null
  return { items: rows.slice(0, q.limit).map(toPublic), nextCursor: last?.publishedAt ? encodeCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id }) : null }
}

export async function publicCollections(db: Db): Promise<CollectionV1[]> {
  const rows = await db.collection.findMany({ where: { hidden: false }, orderBy: [{ position: "asc" }, { title: "asc" }] })
  return rows.map(c => ({ version: 1, id: as<CollectionId>(c.id), handle: c.handle, title: c.title, hidden: false }))
}

/**
 * The collection page read (Stage 10.05): one visible collection by handle and a page of its
 * members that pass the publication filter, in the product list's order (newest published first,
 * ties by ID). Null for hidden and unknown handles alike.
 */
export async function publicCollectionPage(db: Db, handle: string, q: { limit: number; after: { publishedAt: string; id: string } | null }) {
  const row = await db.collection.findFirst({ where: { handle, hidden: false } })
  if (!row) return null
  const { items, nextCursor } = await publicProducts(db, { collectionHandle: handle, limit: q.limit, after: q.after })
  const page: CollectionPageV1 = { version: 1, collection: { version: 1, id: as<CollectionId>(row.id), handle: row.handle, title: row.title, hidden: false }, products: items }
  return { page, nextCursor }
}
