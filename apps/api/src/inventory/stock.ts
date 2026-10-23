// Staff stock operations and read models (Stage 09). Receive, adjust and write off each run in one
// transaction: check the balance's ETag (its version), apply the ledger movement, write the audit
// event. If any step fails, none of it is kept (CHV-S09-003). An optional Idempotency-Key makes a
// retried request a no-op that returns the same result.
import type { Prisma } from "../db/generated/client.ts"
import { ApiError, encodeCursor, etagOf } from "../admin/api.ts"
import { recordAdminEvent, type AdminActor } from "../audit/catalogue.ts"
import type { Db, Tx } from "../db/client.ts"
import { applyMovement, InsufficientStockError, isDuplicateKey } from "./ledger.ts"

export const ADJUST_REASONS = ["found", "damaged", "lost", "data_entry", "other"] as const
export const WRITE_OFF_REASONS = ["damaged", "lost", "expired", "sample", "other"] as const
export const MAX_UNITS = 100_000

export type StaffChange = { actor: AdminActor & { kind: "staff" }; correlationId: string; reason: string; idempotencyKey: string | null }

export const balanceEtag = (b: { variantId: string; version: number }) => etagOf({ balance: b.variantId, version: b.version })

const BALANCE_SELECT = {
  variantId: true,
  onHand: true,
  reserved: true,
  allocated: true,
  version: true,
  lastCountedAt: true,
  lowStockThreshold: true,
  variant: { select: { sku: true, title: true, archivedAt: true, product: { select: { id: true, title: true, handle: true, status: true } } } },
} satisfies Prisma.InventoryBalanceSelect

type BalanceRow = Prisma.InventoryBalanceGetPayload<{ select: typeof BALANCE_SELECT }>

export function toStockView(b: BalanceRow) {
  const available = b.onHand - b.reserved - b.allocated
  return {
    variantId: b.variantId,
    sku: b.variant.sku,
    variantTitle: b.variant.title,
    product: b.variant.product,
    archived: b.variant.archivedAt !== null,
    onHand: b.onHand,
    reserved: b.reserved,
    allocated: b.allocated,
    available,
    lowStockThreshold: b.lowStockThreshold,
    lowStock: b.lowStockThreshold !== null && available <= b.lowStockThreshold,
    lastCountedAt: b.lastCountedAt?.toISOString() ?? null,
    /** For sale only once counted in an approved stocktake, on a live product, with units available. */
    sellable: b.lastCountedAt !== null && b.variant.archivedAt === null && b.variant.product.status === "active" && available > 0,
    etag: balanceEtag(b),
  }
}

export async function loadStock(db: Db | Tx, variantId: string) {
  const row = await db.inventoryBalance.findUnique({ where: { variantId }, select: BALANCE_SELECT })
  if (!row) throw new ApiError(404, "not_found", "not found")
  return toStockView(row)
}

export type StockQuery = { search: string | null; lowStock: boolean; uncounted: boolean; limit: number; after: { sku: string } | null }

export async function listStock(db: Db, q: StockQuery) {
  const term = q.search?.trim()
  const filters: Prisma.InventoryBalanceWhereInput[] = [{ variant: { archivedAt: null } }]
  if (term) filters.push({ OR: [{ variant: { sku: { contains: term.toUpperCase() } } }, { variant: { product: { title: { contains: term, mode: "insensitive" } } } }] })
  if (q.uncounted) filters.push({ lastCountedAt: null })
  if (q.after) filters.push({ variant: { sku: { gt: q.after.sku } } })
  // Low stock compares two columns, which Prisma filters cannot express: filter after reading.
  const rows = await db.inventoryBalance.findMany({ where: { AND: filters }, select: BALANCE_SELECT, orderBy: { variant: { sku: "asc" } }, take: q.lowStock ? 1000 : q.limit + 1 })
  const views = rows.map(toStockView).filter(v => !q.lowStock || v.lowStock)
  const items = views.slice(0, q.limit)
  return { items, nextCursor: views.length > q.limit ? encodeCursor({ sku: items[items.length - 1].sku }) : null }
}

export async function listMovements(db: Db, variantId: string, { limit, after }: { limit: number; after: { id: string } | null }) {
  const rows = await db.inventoryMovement.findMany({
    where: { variantId, ...(after && { id: { lt: after.id } }) },
    orderBy: { id: "desc" },
    take: limit + 1,
  })
  const items = rows.slice(0, limit).map(m => ({
    id: m.id,
    type: m.type,
    quantity: m.quantity,
    reasonCode: m.reasonCode,
    reason: m.reason,
    actorKind: m.actorKind,
    actorId: m.actorId,
    reference: { type: m.referenceType, id: m.referenceId },
    onHandAfter: m.onHandAfter,
    reservedAfter: m.reservedAfter,
    allocatedAfter: m.allocatedAfter,
    occurredAt: m.occurredAt.toISOString(),
  }))
  return { items, nextCursor: rows.length > limit ? encodeCursor({ id: items[items.length - 1].id }) : null }
}

export function units(value: unknown, field = "quantity", { signed = false } = {}) {
  const n = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n === 0 || (!signed && n < 0) || Math.abs(n) > MAX_UNITS) {
    throw new ApiError(400, "invalid_request", `${field} must be a whole number of units${signed ? " other than 0" : " above 0"}, at most ${MAX_UNITS}`, { [field]: "invalid" })
  }
  return n
}

/** Loads the balance inside the change and checks If-Match against its version. */
async function begin(tx: Tx, variantId: string, ifMatch: string | undefined) {
  const row = await tx.inventoryBalance.findUnique({ where: { variantId }, select: BALANCE_SELECT })
  if (!row) throw new ApiError(404, "not_found", "not found")
  if (row.variant.archivedAt) throw new ApiError(409, "conflict", "this variant is archived")
  if (!ifMatch) throw new ApiError(428, "precondition_required", "If-Match header required: load the stock record first")
  if (ifMatch !== balanceEtag(row)) throw new ApiError(412, "precondition_failed", "the stock changed since you loaded it; reload and try again")
  return row
}

const staffKey = (change: StaffChange) => (change.idempotencyKey ? `staff:${change.actor.id}:${change.idempotencyKey}` : undefined)

async function run(database: Db, variantId: string, ifMatch: string | undefined, change: StaffChange, body: (tx: Tx) => Promise<void>) {
  try {
    await database.$transaction(async tx => {
      // A retried request with the same key returns the first result without checking the ETag again.
      const key = staffKey(change)
      if (key && (await tx.inventoryMovement.findUnique({ where: { idempotencyKey: key }, select: { id: true } }))) return
      await begin(tx, variantId, ifMatch)
      await body(tx)
    })
  } catch (error) {
    if (error instanceof InsufficientStockError) throw new ApiError(409, "conflict", "that would take stock below what is held for orders; nothing was changed", { quantity: "too large" })
    if (isDuplicateKey(error)) return // a concurrent retry with the same key won; its result stands
    throw error
  }
  return loadStock(database, variantId)
}

export function receive(database: Db, variantId: string, ifMatch: string | undefined, quantity: number, change: StaffChange) {
  return run(database, variantId, ifMatch, change, async tx => {
    const { balance } = await applyMovement(tx, { variantId, type: "receipt", quantity, reason: change.reason, reasonCode: "receipt", actor: { kind: "staff", id: change.actor.id }, reference: { type: "adjustment", id: change.correlationId }, idempotencyKey: staffKey(change) })
    await recordAdminEvent(tx, { action: "inventory.received", actor: change.actor, entity: { type: "product_variant", id: variantId }, reason: change.reason, after: { quantity, onHand: balance.onHand }, correlationId: change.correlationId })
  }).then(view => view ?? loadStock(database, variantId))
}

export function adjust(database: Db, variantId: string, ifMatch: string | undefined, delta: number, reasonCode: string, change: StaffChange) {
  return run(database, variantId, ifMatch, change, async tx => {
    await applyMovement(tx, { variantId, type: "correction", quantity: delta, reason: change.reason, reasonCode, actor: { kind: "staff", id: change.actor.id }, reference: { type: "adjustment", id: change.correlationId }, idempotencyKey: staffKey(change) })
    await recordAdminEvent(tx, { action: "inventory.adjusted", actor: change.actor, entity: { type: "product_variant", id: variantId }, reason: change.reason, after: { delta, reasonCode }, correlationId: change.correlationId })
  }).then(view => view ?? loadStock(database, variantId))
}

export function writeOff(database: Db, variantId: string, ifMatch: string | undefined, quantity: number, reasonCode: string, change: StaffChange) {
  return run(database, variantId, ifMatch, change, async tx => {
    await applyMovement(tx, { variantId, type: "write_off", quantity, reason: change.reason, reasonCode, actor: { kind: "staff", id: change.actor.id }, reference: { type: "adjustment", id: change.correlationId }, idempotencyKey: staffKey(change) })
    await recordAdminEvent(tx, { action: "inventory.written_off", actor: change.actor, entity: { type: "product_variant", id: variantId }, reason: change.reason, after: { quantity, reasonCode }, correlationId: change.correlationId })
  }).then(view => view ?? loadStock(database, variantId))
}

export async function setThreshold(database: Db, variantId: string, ifMatch: string | undefined, threshold: number | null, change: Omit<StaffChange, "reason"> & { reason: string | null }) {
  await database.$transaction(async tx => {
    const row = await begin(tx, variantId, ifMatch)
    const { count } = await tx.inventoryBalance.updateMany({ where: { variantId, version: row.version }, data: { lowStockThreshold: threshold, version: { increment: 1 } } })
    if (count !== 1) throw new ApiError(412, "precondition_failed", "the stock changed since you loaded it; reload and try again")
    await recordAdminEvent(tx, { action: "inventory.settings_changed", actor: change.actor, entity: { type: "product_variant", id: variantId }, reason: change.reason ?? "", after: { lowStockThreshold: threshold }, correlationId: change.correlationId })
  })
  return loadStock(database, variantId)
}
