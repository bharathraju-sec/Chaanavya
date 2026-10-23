// Collection administration (Stage 08). The four storefront categories (dresses, ethnic-festive,
// jewellery, fragrance) are rows with `storefront = true`: their handles are page URLs and cannot
// change (also enforced by a database trigger), and they cannot be deleted. New collections start
// hidden; showing a collection to shoppers needs catalogue.publish.
import { Prisma } from "../db/generated/client.ts"
import { ApiError, etagOf } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db } from "../db/client.ts"
import { handleOf, text } from "./rules.ts"
import type { Change } from "./products.ts"

type Row = { id: string; handle: string; title: string; description: string; hidden: boolean; position: number; storefront: boolean; version: number; _count?: { products: number } }

export const collectionEtag = (c: { id: string; version: number }) => etagOf({ collection: c.id, version: c.version })

const view = (c: Row) => ({ id: c.id, handle: c.handle, title: c.title, description: c.description, hidden: c.hidden, position: c.position, storefront: c.storefront, productCount: c._count?.products ?? 0, etag: collectionEtag(c) })

export async function listCollections(db: Db) {
  const rows = await db.collection.findMany({ orderBy: [{ position: "asc" }, { title: "asc" }], include: { _count: { select: { products: true } } } })
  return rows.map(view)
}

export async function loadCollection(db: Db, id: string) {
  const row = await db.collection.findUnique({ where: { id }, include: { _count: { select: { products: true } } } })
  if (!row) throw new ApiError(404, "not_found", "not found")
  return view(row)
}

type Fields = { handle?: string; title?: string; description?: string; hidden?: boolean; position?: number }

export function collectionFields(body: Record<string, unknown>, { creating }: { creating: boolean }): Fields {
  const fields: Fields = {}
  if (creating || "handle" in body) fields.handle = handleOf(body.handle)
  if (creating || "title" in body) fields.title = text(body.title, "title", { min: 1, max: 120 })
  if (creating || "description" in body) fields.description = text(body.description, "description", { max: 2000 })
  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") throw new ApiError(400, "invalid_request", "hidden must be true or false", { hidden: "invalid" })
    fields.hidden = body.hidden
  }
  if ("position" in body) {
    const position = Number(body.position)
    if (!Number.isInteger(position) || position < 0 || position > 1000) throw new ApiError(400, "invalid_request", "position must be 0 to 1000", { position: "invalid" })
    fields.position = position
  }
  return fields
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"

export async function createCollection(database: Db, fields: Fields, change: Change) {
  if (fields.hidden === false && !change.canPublish) throw new ApiError(403, "forbidden", "only staff who may publish can show a collection to shoppers")
  try {
    return await database.$transaction(async tx => {
      const row = await tx.collection.create({ data: { handle: fields.handle!, title: fields.title!, description: fields.description ?? "", hidden: fields.hidden ?? true, position: fields.position ?? 100 } })
      await recordAdminEvent(tx, { action: "collection.created", actor: change.actor, entity: { type: "collection", id: row.id }, reason: change.reason ?? "", after: { handle: row.handle }, correlationId: change.correlationId })
      return row.id
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "conflict", `the handle ${fields.handle} is already used`, { handle: "already used" })
    throw error
  }
}

export async function updateCollection(database: Db, id: string, ifMatch: string | undefined, fields: Fields, change: Change) {
  try {
    await database.$transaction(async tx => {
      const row = await tx.collection.findUnique({ where: { id } })
      if (!row) throw new ApiError(404, "not_found", "not found")
      if (!ifMatch) throw new ApiError(428, "precondition_required", "If-Match header required: load the collection first")
      if (ifMatch !== collectionEtag(row)) throw new ApiError(412, "precondition_failed", "the collection changed since you loaded it; reload and try again")
      if (row.storefront && fields.handle !== undefined && fields.handle !== row.handle) throw new ApiError(409, "conflict", "storefront categories keep their handle: it is the page URL", { handle: "fixed" })
      if (fields.hidden !== undefined && fields.hidden !== row.hidden && !change.canPublish) throw new ApiError(403, "forbidden", "only staff who may publish can show or hide a collection")
      if (fields.hidden !== undefined && fields.hidden !== row.hidden && !change.reason) throw new ApiError(400, "invalid_request", "a reason is required to show or hide a collection", { reason: "required" })
      const { count } = await tx.collection.updateMany({ where: { id, version: row.version }, data: { ...fields, version: { increment: 1 } } })
      if (count !== 1) throw new ApiError(412, "precondition_failed", "the collection changed since you loaded it; reload and try again")
      await recordAdminEvent(tx, { action: "collection.updated", actor: change.actor, entity: { type: "collection", id }, reason: change.reason ?? "", after: { fields: Object.keys(fields).sort().join(",") }, correlationId: change.correlationId })
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "conflict", `the handle ${fields.handle} is already used`, { handle: "already used" })
    throw error
  }
}
