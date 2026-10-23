// Product administration (Stage 08): drafts, variants, publishing and the admin read model.
//
// Every change runs in one transaction that (1) loads the product and compares its ETag (the
// product's version) with If-Match, (2) applies the change, (3) increments the version with a
// compare-and-set, (4) writes the audit event and, when shoppers can see the product, a
// catalogue.updated outbox event. Any failure rolls all of it back: no partial writes.
//
// Live products: editing anything shoppers see on an active product needs catalogue.publish and a
// reason (the same people who may publish). Drafts can be edited by anyone with catalogue.write.
import { Prisma } from "../db/generated/client.ts"
import { ApiError, encodeCursor, etagOf } from "../admin/api.ts"
import { recordAdminEvent, type AdminActor } from "../audit/catalogue.ts"
import type { Db, Tx } from "../db/client.ts"
import { writeOutbox } from "../outbox/outbox.ts"
import { mediaStorage } from "../media/storage.ts"
import {
  checklistFor,
  checklistOf,
  handleOf,
  idList,
  optionDefinitions,
  optionKeyOf,
  publishBlockers,
  restrictionOf,
  slugify,
  tagsOf,
  text,
  variantInputs,
  variantTitle,
  type Blocker,
  type OptionDefinition,
  type ShippingRestriction,
} from "./rules.ts"

export type Change = { actor: AdminActor; correlationId: string; reason: string | null; canPublish: boolean }

const PRODUCT_INCLUDE = {
  collections: { include: { collection: { select: { id: true, handle: true, title: true } } }, orderBy: { position: "asc" } },
  variants: { where: { archivedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
  media: { where: { removedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.ProductInclude

type ProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>

export const productEtag = (p: { id: string; version: number }) => etagOf({ product: p.id, version: p.version })

const money = (paise: bigint | null) => (paise === null ? null : paise.toString())
const optionsOf = (selected: unknown) => (Array.isArray(selected) ? (selected as { name: string; value: string }[]) : [])

/** The options a product uses, in order, from its active variants. */
export function productOptions(variants: { selectedOptions: unknown }[]): OptionDefinition[] {
  const options: OptionDefinition[] = []
  for (const v of variants) {
    for (const { name, value } of optionsOf(v.selectedOptions)) {
      let option = options.find(o => o.name === name)
      if (!option) options.push((option = { name: name as OptionDefinition["name"], values: [] }))
      if (!option.values.includes(value)) option.values.push(value)
    }
  }
  return options
}

const candidateOf = (p: ProductRow) => ({
  title: p.title,
  handle: p.handle,
  description: p.description,
  shippingRestriction: p.shippingRestriction as ShippingRestriction | null,
  collections: p.collections.map(c => c.collection.handle),
  variants: p.variants.map(v => ({ sku: v.sku, pricePaise: v.pricePaise, compareAtPricePaise: v.compareAtPricePaise, taxCategory: v.taxCategory, selectedOptions: optionsOf(v.selectedOptions) })),
  media: p.media.map(m => ({ status: m.status, altText: m.altText })),
})

export type AdminProductView = Awaited<ReturnType<typeof toAdminView>>

/** The editor's view. Pending photos get a 10-minute signed preview link; nothing else is private. */
export async function toAdminView(p: ProductRow) {
  const candidate = candidateOf(p)
  const blockers: Blocker[] = p.status === "archived" ? [] : publishBlockers(candidate)
  const storage = p.media.some(m => m.status !== "approved" && m.stagingKey) ? mediaStorage() : null
  const media = await Promise.all(
    p.media.map(async m => ({
      id: m.id,
      status: m.status,
      url: m.url,
      previewUrl: m.status === "approved" ? m.url : m.stagingKey && storage ? await storage.signRead(m.stagingKey, 600) : null,
      altText: m.altText,
      width: m.width,
      height: m.height,
      byteSize: m.byteSize,
      contentType: m.contentType,
      position: m.position,
    })),
  )
  return {
    id: p.id,
    handle: p.handle,
    status: p.status,
    title: p.title,
    description: p.description,
    productType: p.productType,
    tags: p.tags,
    shippingRestriction: p.shippingRestriction,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    approvedAt: p.approvedAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
    /** Handles become fixed once a product has been live: its URL may be bookmarked or indexed. */
    handleLocked: p.publishedAt !== null,
    collections: p.collections.map(c => c.collection),
    options: productOptions(p.variants),
    variants: p.variants.map(v => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      options: Object.fromEntries(optionsOf(v.selectedOptions).map(o => [o.name, o.value])),
      pricePaise: money(v.pricePaise),
      compareAtPricePaise: money(v.compareAtPricePaise),
      currency: v.currency,
      taxCategory: v.taxCategory,
      hsnCode: v.hsnCode,
      weightGrams: v.weightGrams,
      mediaId: v.mediaId,
    })),
    media,
    checklist: checklistFor(candidate.collections),
    blockers,
    etag: productEtag(p),
  }
}

async function loadRow(db: Db | Tx, id: string) {
  const row = await db.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE })
  if (!row) throw new ApiError(404, "not_found", "not found")
  return row
}

export const loadProduct = async (db: Db, id: string) => toAdminView(await loadRow(db, id))

/** Loads the product inside a change, checks If-Match and the live-edit rule. */
async function begin(tx: Tx, id: string, ifMatch: string | undefined, change: Change, { live = true } = {}) {
  const row = await loadRow(tx, id)
  if (!ifMatch) throw new ApiError(428, "precondition_required", "If-Match header required: load the product first")
  if (ifMatch !== productEtag(row)) throw new ApiError(412, "precondition_failed", "the product changed since you loaded it; reload and try again")
  if (row.status === "archived" && live) throw new ApiError(409, "conflict", "restore the product before editing it")
  if (row.status === "active" && live) {
    if (!change.canPublish) throw new ApiError(403, "forbidden", "this product is live; only staff who may publish can change it")
    if (!change.reason) throw new ApiError(400, "invalid_request", "a reason of 3 to 500 characters is required to change a live product", { reason: "required" })
  }
  return row
}

/** Compare-and-set on the version: a concurrent change makes this fail instead of overwriting it. */
async function bump(tx: Tx, row: { id: string; version: number }, data: Prisma.ProductUpdateManyMutationInput = {}) {
  const { count } = await tx.product.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: { increment: 1 } } })
  if (count !== 1) throw new ApiError(412, "precondition_failed", "the product changed since you loaded it; reload and try again")
}

async function announce(tx: Tx, productId: string, change: "published" | "unpublished" | "archived" | "changed" | "media") {
  const p = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { handle: true, collections: { select: { collection: { select: { handle: true } } } } } })
  await writeOutbox(tx, "catalogue.updated", { type: "product", id: productId }, { productId, handle: p.handle, collections: p.collections.map(c => c.collection.handle), change })
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"

async function assertCollections(tx: Tx, ids: string[]) {
  if (ids.length === 0) return
  const found = await tx.collection.count({ where: { id: { in: ids } } })
  if (found !== ids.length) throw new ApiError(400, "invalid_request", "unknown collection", { collectionIds: "unknown collection" })
}

async function setCollections(tx: Tx, productId: string, ids: string[]) {
  await tx.productCollection.deleteMany({ where: { productId, collectionId: { notIn: ids } } })
  for (const [position, collectionId] of ids.entries()) {
    await tx.productCollection.upsert({ where: { productId_collectionId: { productId, collectionId } }, update: { position }, create: { productId, collectionId, position } })
  }
}

// ---- reads -----------------------------------------------------------------------------------

export type ProductListQuery = { search: string | null; status: "draft" | "active" | "archived" | null; collectionId: string | null; limit: number; after: { createdAt: string; id: string } | null }

export async function listProducts(db: Db, q: ProductListQuery) {
  const term = q.search?.trim()
  const filters: Prisma.ProductWhereInput[] = []
  if (q.status) filters.push({ status: q.status })
  if (q.collectionId) filters.push({ collections: { some: { collectionId: q.collectionId } } })
  if (term) filters.push({ OR: searchOr(term) })
  if (q.after) filters.push({ OR: [{ createdAt: { lt: new Date(q.after.createdAt) } }, { createdAt: new Date(q.after.createdAt), id: { lt: q.after.id } }] })
  const rows = await db.product.findMany({
    where: { AND: filters },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    select: {
      id: true,
      handle: true,
      title: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      version: true,
      variants: { where: { archivedAt: null }, select: { pricePaise: true } },
      media: { where: { removedAt: null, status: "approved" }, orderBy: { position: "asc" }, take: 1, select: { url: true, altText: true } },
      _count: { select: { media: { where: { removedAt: null, status: "pending" } } } },
    },
  })
  const items = rows.slice(0, q.limit).map(r => {
    const prices = r.variants.map(v => v.pricePaise)
    const min = prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : null
    const max = prices.length ? prices.reduce((a, b) => (b > a ? b : a)) : null
    return {
      id: r.id,
      handle: r.handle,
      title: r.title,
      status: r.status,
      variantCount: prices.length,
      priceFromPaise: money(min),
      priceToPaise: money(max),
      image: r.media[0] ?? null,
      pendingPhotos: r._count.media,
      updatedAt: r.updatedAt.toISOString(),
      etag: productEtag(r),
    }
  })
  const last = rows.length > q.limit ? rows[q.limit - 1] : null
  return { items, nextCursor: last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null }
}

const searchOr = (term: string): Prisma.ProductWhereInput[] => [
  { title: { contains: term, mode: "insensitive" } },
  { handle: { contains: term.toLowerCase() } },
  { variants: { some: { sku: { contains: term.toUpperCase() }, archivedAt: null } } },
]

// ---- product fields ----------------------------------------------------------------------------

type ProductFields = { title?: string; handle?: string; description?: string; productType?: string; tags?: string[]; shippingRestriction?: ShippingRestriction | null; collectionIds?: string[] }

export function productFields(body: Record<string, unknown>, { creating }: { creating: boolean }): ProductFields {
  const has = (name: string) => creating || name in body
  const fields: ProductFields = {}
  if (has("title")) fields.title = text(body.title, "title", { min: 1, max: 200 })
  if ("handle" in body && body.handle !== "" && body.handle !== null) fields.handle = handleOf(body.handle)
  if (has("description")) fields.description = text(body.description, "description", { max: 10_000 })
  if (has("productType")) fields.productType = text(body.productType, "productType", { max: 80 })
  if (has("tags")) fields.tags = tagsOf(body.tags)
  if (has("shippingRestriction")) fields.shippingRestriction = restrictionOf(body.shippingRestriction)
  if (has("collectionIds")) fields.collectionIds = idList(body.collectionIds, "collectionIds")
  return fields
}

/** A free handle from the title: "kurta", else "kurta-2", "kurta-3" ... */
async function freeHandle(db: Db, title: string) {
  const base = slugify(title).slice(0, 90)
  const taken = new Set((await db.product.findMany({ where: { handle: { startsWith: base } }, select: { handle: true } })).map(p => p.handle))
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new ApiError(409, "conflict", "choose a handle for this product", { handle: "already used" })
}

export async function createProduct(database: Db, fields: ProductFields, change: Change) {
  // A handle typed by staff must be free; one made from the title gets a number if needed.
  const handle = fields.handle ?? (await freeHandle(database, fields.title ?? ""))
  try {
    return await database.$transaction(async tx => {
      await assertCollections(tx, fields.collectionIds ?? [])
      const product = await tx.product.create({
        data: { handle, title: fields.title!, description: fields.description ?? "", productType: fields.productType ?? "", tags: fields.tags ?? [], shippingRestriction: fields.shippingRestriction ?? null, status: "draft" },
      })
      await setCollections(tx, product.id, fields.collectionIds ?? [])
      await recordAdminEvent(tx, { action: "product.created", actor: change.actor, entity: { type: "product", id: product.id }, reason: change.reason ?? "", after: { handle, status: "draft" }, correlationId: change.correlationId })
      return product.id
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "conflict", `the handle ${handle} is already used by another product`, { handle: "already used" })
    throw error
  }
}

export async function updateProduct(database: Db, id: string, ifMatch: string | undefined, fields: ProductFields, change: Change) {
  try {
    await database.$transaction(async tx => {
      const row = await begin(tx, id, ifMatch, change)
      if (fields.handle !== undefined && fields.handle !== row.handle && row.publishedAt) throw new ApiError(409, "conflict", "the handle is fixed once a product has been live", { handle: "fixed" })
      if (fields.collectionIds) await assertCollections(tx, fields.collectionIds)
      const { collectionIds, ...scalar } = fields
      await bump(tx, row, scalar)
      if (collectionIds) await setCollections(tx, id, collectionIds)
      const live = row.status === "active"
      await recordAdminEvent(tx, { action: "product.updated", actor: change.actor, entity: { type: "product", id }, reason: change.reason ?? "", after: { fields: Object.keys(fields).sort().join(","), live }, correlationId: change.correlationId })
      if (live) {
        // A live product must still pass every publish check after the edit.
        const blockers = publishBlockers(candidateOf(await loadRow(tx, id)))
        if (blockers.length) throw new ApiError(409, "conflict", `this change would break the live product: ${blockers[0].message}`)
        await announce(tx, id, "changed")
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "conflict", `the handle ${fields.handle} is already used by another product`, { handle: "already used" })
    throw error
  }
}

// ---- variants ----------------------------------------------------------------------------------

/**
 * Replaces the product's variant list with `body.variants` in one transaction: variants with an id
 * are updated, new ones created (with an empty stock balance), missing ones archived (never deleted:
 * carts and orders point at them). Stock is never written here. SKUs are unique among active
 * variants of every product, option combinations unique per product; any clash rolls back everything.
 */
export async function saveVariants(database: Db, id: string, ifMatch: string | undefined, body: Record<string, unknown>, change: Change) {
  const options = optionDefinitions(body.options)
  const inputs = variantInputs(body.variants, options)
  try {
    return await database.$transaction(async tx => {
      const row = await begin(tx, id, ifMatch, change)
      const current = new Map(row.variants.map(v => [v.id, v]))
      for (const [i, input] of inputs.entries()) {
        if (input.id && !current.has(input.id)) throw new ApiError(400, "invalid_request", "unknown variant", { [`variants.${i}.id`]: "not a variant of this product" })
        if (input.mediaId && !row.media.some(m => m.id === input.mediaId)) throw new ApiError(400, "invalid_request", "unknown photo", { [`variants.${i}.mediaId`]: "not a photo of this product" })
      }
      const clash = await tx.productVariant.findMany({ where: { sku: { in: inputs.map(v => v.sku) }, archivedAt: null, productId: { not: id } }, select: { sku: true } })
      if (clash.length) {
        const sku = clash[0].sku
        throw new ApiError(409, "conflict", `SKU ${sku} is already used by another product`, { [`variants.${inputs.findIndex(v => v.sku === sku)}.sku`]: "already used" })
      }

      const kept = new Set(inputs.map(v => v.id).filter(Boolean))
      const archived = row.variants.filter(v => !kept.has(v.id))
      const now = new Date()
      // Archived variants give up their option key (it is unique per product) but keep their SKU for history.
      for (const v of archived) await tx.productVariant.update({ where: { id: v.id }, data: { archivedAt: now, optionKey: `archived:${v.id}`, version: { increment: 1 } } })
      // Two passes so variants can swap SKUs or option combinations without a transient clash.
      const updates = inputs.filter(v => v.id)
      for (const v of updates) await tx.productVariant.update({ where: { id: v.id! }, data: { sku: `~${v.id}`, optionKey: `~${v.id}` } })

      const repriced: { id: string; before: bigint; after: bigint }[] = []
      let created = 0
      for (const [position, v] of inputs.entries()) {
        const selectedOptions = options.map(o => ({ name: o.name, value: v.options[o.name] }))
        const data = {
          sku: v.sku,
          title: variantTitle(v.options, options),
          selectedOptions,
          optionKey: optionKeyOf(v.options),
          pricePaise: v.pricePaise,
          compareAtPricePaise: v.compareAtPricePaise,
          taxCategory: v.taxCategory,
          hsnCode: v.hsnCode,
          weightGrams: v.weightGrams,
          mediaId: v.mediaId,
          position,
        }
        if (v.id) {
          const before = current.get(v.id)!
          if (before.pricePaise !== v.pricePaise) repriced.push({ id: v.id, before: before.pricePaise, after: v.pricePaise })
          await tx.productVariant.update({ where: { id: v.id }, data: { ...data, version: { increment: 1 } } })
        } else {
          const variant = await tx.productVariant.create({ data: { ...data, productId: id } })
          await tx.inventoryBalance.create({ data: { variantId: variant.id } })
          created++
        }
      }
      await bump(tx, row)
      await recordAdminEvent(tx, {
        action: "product.variants_saved",
        actor: change.actor,
        entity: { type: "product", id },
        reason: change.reason ?? "",
        after: { created, updated: updates.length, archived: archived.length },
        correlationId: change.correlationId,
      })
      if (row.status === "active") {
        for (const r of repriced) {
          await recordAdminEvent(tx, { action: "price.changed", actor: change.actor, entity: { type: "product_variant", id: r.id }, reason: change.reason!, before: { pricePaise: r.before.toString() }, after: { pricePaise: r.after.toString() }, correlationId: change.correlationId })
        }
        const blockers = publishBlockers(candidateOf(await loadRow(tx, id)))
        if (blockers.length) throw new ApiError(409, "conflict", `this change would break the live product: ${blockers[0].message}`)
        await announce(tx, id, "changed")
      }
      return { created, updated: updates.length, archived: archived.length }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "conflict", "a SKU or option combination is already in use; nothing was saved")
    throw error
  }
}

// ---- status ------------------------------------------------------------------------------------

export type StatusAction = "publish" | "unpublish" | "archive" | "restore"

const TRANSITIONS: Record<StatusAction, { from: string[]; to: "draft" | "active" | "archived" }> = {
  publish: { from: ["draft"], to: "active" },
  unpublish: { from: ["active"], to: "draft" },
  archive: { from: ["draft", "active"], to: "archived" },
  restore: { from: ["archived"], to: "draft" },
}

/** Publishing, unpublishing, archiving and restoring: catalogue.publish and a reason, always audited. */
export async function changeStatus(database: Db, id: string, ifMatch: string | undefined, action: StatusAction, body: Record<string, unknown>, change: Change & { reason: string }) {
  if (!change.canPublish) throw new ApiError(403, "forbidden", "only staff who may publish can change a product's status")
  return database.$transaction(async tx => {
    const row = await begin(tx, id, ifMatch, change, { live: false })
    const transition = TRANSITIONS[action]
    if (!transition.from.includes(row.status)) throw new ApiError(409, "conflict", `a ${row.status} product cannot be ${action === "publish" ? "published" : `${action}d`}`)
    let data: Prisma.ProductUpdateManyMutationInput = { status: transition.to }
    if (action === "publish") {
      const candidate = candidateOf(row)
      const blockers = publishBlockers(candidate)
      if (blockers.length) throw new ApiError(409, "conflict", "the product is not ready to publish", Object.fromEntries(blockers.map((b, i) => [`blockers.${i}`, b.message])))
      const approval = checklistOf(body.checklist, checklistFor(candidate.collections))
      const now = new Date()
      data = { ...data, approval: { ...approval, confirmedAt: now.toISOString() }, approvedAt: now, approvedById: change.actor.kind === "staff" ? change.actor.id : null, publishedAt: row.publishedAt ?? now }
    }
    await bump(tx, row, data)
    await recordAdminEvent(tx, { action: "product.status_changed", actor: change.actor, entity: { type: "product", id }, reason: change.reason, before: { status: row.status }, after: { status: transition.to }, correlationId: change.correlationId })
    if (action === "publish") await announce(tx, id, "published")
    if (row.status === "active" && action !== "publish") await announce(tx, id, action === "archive" ? "archived" : "unpublished")
    return transition.to
  })
}
