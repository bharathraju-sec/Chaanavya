// Physical stocktakes and controlled stock imports (Stage 09).
//
//   draft      staff enter counts by hand or import a count file (owner CSV, or an old Shopify export
//              as reference only: its quantities are never used as counts)
//   submitted  counting is finished; the lines are frozen
//   approved   an owner reviews the reconciliation report (books versus count for every SKU, plus the
//              listing checks), accepts every discrepancy, types their name as a signature and
//              approves. In one transaction the differences become ledger corrections, the counted
//              SKUs get their last-counted date (which makes them sellable), and the signed report is
//              stored. An approved stocktake can never change again (database trigger).
//
// Imports are idempotent: the same file (SHA-256) always returns the same stocktake, and approving
// twice is impossible. Synthetic, placeholder or demonstration SKUs are refused outright, so sample
// data can never become sellable stock (CHV-S09-004).
import { createHash } from "node:crypto"
import { ApiError, encodeCursor, etagOf } from "../admin/api.ts"
import { recordAdminEvent, type AdminActor } from "../audit/catalogue.ts"
import { parseCsv } from "../catalogue/csv.ts"
import { isDemonstration } from "../catalogue/rules.ts"
import type { Prisma } from "../db/generated/client.ts"
import type { Db, Tx } from "../db/client.ts"
import { announceStockChange } from "../outbox/outbox.ts"
import { applyMovement, InsufficientStockError } from "./ledger.ts"

export const STOCKTAKE_MAX_LINES = 5000
export const IMPORT_SOURCES = ["owner_csv", "shopify_export"] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

type Staff = AdminActor & { kind: "staff" }
export type StocktakeChange = { actor: Staff; correlationId: string }

export const stocktakeEtag = (s: { id: string; version: number }) => etagOf({ stocktake: s.id, version: s.version })

const LINE_INCLUDE = {
  lines: {
    include: {
      variant: {
        select: {
          id: true,
          sku: true,
          title: true,
          pricePaise: true,
          currency: true,
          archivedAt: true,
          selectedOptions: true,
          balance: { select: { onHand: true, reserved: true, allocated: true } },
          product: {
            select: {
              id: true,
              title: true,
              handle: true,
              status: true,
              media: { where: { status: "approved", removedAt: null }, select: { id: true } },
              collections: { select: { collectionId: true } },
            },
          },
        },
      },
    },
    orderBy: { variant: { sku: "asc" } },
  },
} satisfies Prisma.StocktakeInclude

type Row = Prisma.StocktakeGetPayload<{ include: typeof LINE_INCLUDE }>

/** The reconciliation report: for every counted SKU the books, the count, the difference and the listing checks. */
export function reportOf(s: Row) {
  const lines = s.lines.map(l => {
    const v = l.variant
    const books = v.balance?.onHand ?? 0
    const held = (v.balance?.reserved ?? 0) + (v.balance?.allocated ?? 0)
    const checks: string[] = []
    if (v.archivedAt) checks.push("variant is archived")
    if (v.product.status !== "active") checks.push(`product is ${v.product.status === "draft" ? "a draft (not for sale until published)" : v.product.status}`)
    if (v.pricePaise <= BigInt(0)) checks.push("no price")
    if (v.currency !== "INR") checks.push(`currency is ${v.currency}`)
    if (v.product.media.length === 0) checks.push("no approved photo")
    if (v.product.collections.length === 0) checks.push("not in any collection")
    if (l.counted < held) checks.push(`counted ${l.counted} but ${held} are held for orders`)
    return {
      variantId: v.id,
      sku: v.sku,
      product: v.product.title,
      variant: v.title,
      books,
      counted: l.counted,
      difference: l.counted - books,
      reference: l.reference,
      note: l.note,
      pricePaise: v.pricePaise.toString(),
      currency: v.currency,
      checks,
    }
  })
  return {
    lines,
    totals: {
      skus: lines.length,
      counted: lines.reduce((n, l) => n + l.counted, 0),
      books: lines.reduce((n, l) => n + l.books, 0),
      discrepancies: lines.filter(l => l.difference !== 0).length,
      withChecks: lines.filter(l => l.checks.length).length,
    },
  }
}

export function toStocktakeView(s: Row) {
  // Approved stocktakes show the report exactly as it was signed; others show it as of now.
  const report = s.status === "approved" && s.report ? (s.report as ReturnType<typeof reportOf>) : reportOf(s)
  return {
    id: s.id,
    status: s.status,
    note: s.note,
    source: s.source,
    createdById: s.createdById,
    createdAt: s.createdAt.toISOString(),
    submittedAt: s.submittedAt?.toISOString() ?? null,
    approvedById: s.approvedById,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    signedName: s.signedName,
    report,
    etag: stocktakeEtag(s),
  }
}

export async function loadStocktake(db: Db | Tx, id: string) {
  const row = await db.stocktake.findUnique({ where: { id }, include: LINE_INCLUDE })
  if (!row) throw new ApiError(404, "not_found", "not found")
  return toStocktakeView(row)
}

export async function listStocktakes(db: Db, { limit, after }: { limit: number; after: { id: string } | null }) {
  const rows = await db.stocktake.findMany({ where: after ? { id: { lt: after.id } } : {}, orderBy: { id: "desc" }, take: limit + 1, include: { _count: { select: { lines: true } } } })
  const items = rows.slice(0, limit).map(s => ({ id: s.id, status: s.status, note: s.note, source: s.source, lines: s._count.lines, createdAt: s.createdAt.toISOString(), approvedAt: s.approvedAt?.toISOString() ?? null, signedName: s.signedName }))
  return { items, nextCursor: rows.length > limit ? encodeCursor({ id: items[items.length - 1].id }) : null }
}

type LineInput = { sku: string; counted: number; reference: number | null; note: string }

/** Looks up SKUs (active variants only) and refuses demonstration data. Errors name the line. */
async function resolveLines(tx: Tx, lines: LineInput[], fieldOf: (i: number) => string) {
  const skus = [...new Set(lines.map(l => l.sku))]
  if (skus.length !== lines.length) {
    const seen = new Set<string>()
    const i = lines.findIndex(l => (seen.has(l.sku) ? true : (seen.add(l.sku), false)))
    throw new ApiError(400, "invalid_request", `SKU ${lines[i].sku} is listed twice`, { [fieldOf(i)]: "listed twice" })
  }
  const variants = await tx.productVariant.findMany({ where: { sku: { in: skus }, archivedAt: null }, select: { id: true, sku: true, title: true, product: { select: { title: true, handle: true } } } })
  return lines.map((l, i) => {
    const v = variants.find(x => x.sku === l.sku)
    if (!v) throw new ApiError(400, "invalid_request", `no active variant has SKU ${l.sku}`, { [fieldOf(i)]: "unknown SKU" })
    if (isDemonstration({ title: v.product.title, handle: v.product.handle, variants: [{ sku: v.sku }] as never })) {
      throw new ApiError(400, "invalid_request", `${l.sku} is synthetic or placeholder data and can never be counted as stock`, { [fieldOf(i)]: "demonstration data" })
    }
    return { variantId: v.id, counted: l.counted, reference: l.reference, note: l.note }
  })
}

const count = (value: unknown, field: string, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === "")) return null
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000) throw new ApiError(400, "invalid_request", `${field} must be a whole number of units, 0 or more`, { [field]: "invalid" })
  return n
}

export function lineInputs(value: unknown): LineInput[] {
  if (!Array.isArray(value) || value.length > STOCKTAKE_MAX_LINES) throw new ApiError(400, "invalid_request", `lines must be a list of up to ${STOCKTAKE_MAX_LINES}`, { lines: "invalid" })
  return value.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>
    const sku = typeof l.sku === "string" ? l.sku.trim().toUpperCase() : ""
    if (!sku) throw new ApiError(400, "invalid_request", "every line needs a SKU", { [`lines.${i}.sku`]: "required" })
    const note = typeof l.note === "string" ? l.note.trim().slice(0, 500) : ""
    return { sku, counted: count(l.counted, `lines.${i}.counted`) as number, reference: count(l.reference, `lines.${i}.reference`, { optional: true }), note }
  })
}

export async function createStocktake(database: Db, note: string, change: StocktakeChange) {
  return database.$transaction(async tx => {
    const s = await tx.stocktake.create({ data: { note, createdById: change.actor.id } })
    await recordAdminEvent(tx, { action: "stocktake.created", actor: change.actor, entity: { type: "stocktake", id: s.id }, reason: "", after: { source: "owner_count" }, correlationId: change.correlationId })
    return s.id
  })
}

/** Loads a stocktake inside a change and checks If-Match and that it is still in `status`. */
async function begin(tx: Tx, id: string, ifMatch: string | undefined, status: "draft" | "submitted") {
  const s = await tx.stocktake.findUnique({ where: { id } })
  if (!s) throw new ApiError(404, "not_found", "not found")
  if (!ifMatch) throw new ApiError(428, "precondition_required", "If-Match header required: load the stocktake first")
  if (ifMatch !== stocktakeEtag(s)) throw new ApiError(412, "precondition_failed", "the stocktake changed since you loaded it; reload and try again")
  if (s.status !== status) throw new ApiError(409, "conflict", `this stocktake is ${s.status}`)
  const { count: moved } = await tx.stocktake.updateMany({ where: { id, version: s.version }, data: { version: { increment: 1 } } })
  if (moved !== 1) throw new ApiError(412, "precondition_failed", "the stocktake changed since you loaded it; reload and try again")
  return s
}

/** Replaces the counted lines of a draft. */
export async function setLines(database: Db, id: string, ifMatch: string | undefined, lines: LineInput[], change: StocktakeChange) {
  await database.$transaction(async tx => {
    await begin(tx, id, ifMatch, "draft")
    const resolved = await resolveLines(tx, lines, i => `lines.${i}.sku`)
    await tx.stocktakeLine.deleteMany({ where: { stocktakeId: id } })
    if (resolved.length) await tx.stocktakeLine.createMany({ data: resolved.map(l => ({ ...l, stocktakeId: id })) })
  })
  void change
  return loadStocktake(database, id)
}

/**
 * A count file becomes a draft stocktake. Owner CSV: `sku,counted[,note]`. Shopify export (offline
 * `products_export.csv`, read-only): `Variant SKU` and `Variant Inventory Qty`; the Shopify quantity
 * is kept as a reference figure only and the count starts at 0, to be filled in from a physical count.
 */
/** Owner CSV: `sku,counted[,note][,shopify_quantity]` (the count sheet the Shopify converter writes, once filled in). */
export async function importStocktake(database: Db, csv: string, source: ImportSource, note: string, change: StocktakeChange) {
  const sha = createHash("sha256").update(csv).digest("hex")
  const existing = await database.stocktake.findUnique({ where: { sourceSha256: sha }, select: { id: true } })
  if (existing) return { id: existing.id, created: false }
  let rows: string[][]
  try {
    rows = parseCsv(csv)
  } catch (error) {
    throw new ApiError(400, "invalid_request", `the file is not valid CSV: ${(error as Error).message}`)
  }
  if (rows.length < 2) throw new ApiError(400, "invalid_request", "the file needs a header row and at least one line")
  if (rows.length - 1 > STOCKTAKE_MAX_LINES) throw new ApiError(413, "invalid_request", `up to ${STOCKTAKE_MAX_LINES} lines per file`)
  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  let lines: LineInput[]
  if (source === "owner_csv") {
    if (col("sku") < 0 || col("counted") < 0) throw new ApiError(400, "invalid_request", "an owner count file needs the columns sku and counted", { file: "missing columns" })
    lines = rows.slice(1).map((r, i) => ({
      sku: (r[col("sku")] ?? "").trim().toUpperCase(),
      counted: count(r[col("counted")], `row ${i + 2} counted`) as number,
      // The count sheet from scripts/import/shopify-export.mjs carries the old quantity for reference.
      reference: col("shopify_quantity") >= 0 ? count(r[col("shopify_quantity")], `row ${i + 2} shopify_quantity`, { optional: true }) : null,
      note: col("note") >= 0 ? (r[col("note")] ?? "").trim().slice(0, 500) : "",
    }))
  } else {
    if (col("variant sku") < 0 || col("variant inventory qty") < 0) throw new ApiError(400, "invalid_request", "a Shopify products export needs the columns Variant SKU and Variant Inventory Qty", { file: "missing columns" })
    lines = rows
      .slice(1)
      .filter(r => (r[col("variant sku")] ?? "").trim())
      .map(r => {
        const qty = Number((r[col("variant inventory qty")] ?? "").trim())
        return { sku: r[col("variant sku")].trim().toUpperCase(), counted: 0, reference: Number.isSafeInteger(qty) && qty >= 0 ? qty : null, note: "" }
      })
  }
  if (lines.some(l => !l.sku)) throw new ApiError(400, "invalid_request", "every line needs a SKU", { file: "empty SKU" })
  try {
    return await database.$transaction(async tx => {
      const resolved = await resolveLines(tx, lines, i => `row ${i + 2}`)
      const s = await tx.stocktake.create({ data: { note, source, sourceSha256: sha, createdById: change.actor.id, lines: { create: resolved } } })
      await recordAdminEvent(tx, { action: "stocktake.created", actor: change.actor, entity: { type: "stocktake", id: s.id }, reason: "", after: { source }, correlationId: change.correlationId })
      return { id: s.id, created: true }
    })
  } catch (error) {
    // The same file imported twice at the same moment: the first one wins, the second returns it.
    const winner = await database.stocktake.findUnique({ where: { sourceSha256: sha }, select: { id: true } })
    if (winner) return { id: winner.id, created: false }
    throw error
  }
}

export async function submitStocktake(database: Db, id: string, ifMatch: string | undefined, change: StocktakeChange) {
  await database.$transaction(async tx => {
    await begin(tx, id, ifMatch, "draft")
    const lines = await tx.stocktakeLine.count({ where: { stocktakeId: id } })
    if (lines === 0) throw new ApiError(409, "conflict", "count at least one SKU before submitting")
    await tx.stocktake.update({ where: { id }, data: { status: "submitted", submittedAt: new Date() } })
    await recordAdminEvent(tx, { action: "stocktake.submitted", actor: change.actor, entity: { type: "stocktake", id }, reason: "", after: { lines }, correlationId: change.correlationId })
  })
  return loadStocktake(database, id)
}

export async function cancelStocktake(database: Db, id: string, ifMatch: string | undefined, reason: string, change: StocktakeChange) {
  await database.$transaction(async tx => {
    const s = await tx.stocktake.findUnique({ where: { id }, select: { status: true } })
    if (!s) throw new ApiError(404, "not_found", "not found")
    await begin(tx, id, ifMatch, s.status === "submitted" ? "submitted" : "draft")
    await tx.stocktake.update({ where: { id }, data: { status: "cancelled", sourceSha256: null } })
    await recordAdminEvent(tx, { action: "stocktake.cancelled", actor: change.actor, entity: { type: "stocktake", id }, reason, correlationId: change.correlationId })
  })
  return loadStocktake(database, id)
}

export type Approval = { signedName: string; acceptedSkus: string[]; statement: boolean; reason: string }

/**
 * Approves a submitted stocktake. Every SKU whose count differs from the books must be accepted by
 * name; the approver confirms the statement and signs. Corrections, last-counted dates, the signed
 * report and the audit event commit together, or nothing does.
 */
export async function approveStocktake(database: Db, id: string, ifMatch: string | undefined, approval: Approval, change: StocktakeChange) {
  if (!approval.statement) throw new ApiError(400, "invalid_request", "confirm that the counts are a true physical count", { statement: "required" })
  if (approval.signedName.trim().length < 3) throw new ApiError(400, "invalid_request", "type your full name to sign", { signedName: "required" })
  try {
    await database.$transaction(
      async tx => {
        await begin(tx, id, ifMatch, "submitted")
        const row = await tx.stocktake.findUniqueOrThrow({ where: { id }, include: LINE_INCLUDE })
        const report = reportOf(row)
        const unaccepted = report.lines.filter(l => l.difference !== 0 && !approval.acceptedSkus.includes(l.sku))
        if (unaccepted.length) {
          throw new ApiError(409, "conflict", "accept every discrepancy before approving", Object.fromEntries(unaccepted.map(l => [`accept.${l.sku}`, `books ${l.books}, counted ${l.counted}`])))
        }
        const now = new Date()
        let corrections = 0
        for (const l of report.lines) {
          if (l.difference !== 0) {
            await applyMovement(tx, {
              variantId: l.variantId,
              type: "correction",
              quantity: l.difference,
              reason: l.note || `stocktake ${id}`,
              reasonCode: "stocktake",
              actor: { kind: "staff", id: change.actor.id },
              reference: { type: "stocktake", id },
              idempotencyKey: `stocktake:${id}:${l.variantId}`,
            })
            corrections++
          }
          await tx.inventoryBalance.update({ where: { variantId: l.variantId }, data: { lastCountedAt: now, version: { increment: 1 } } })
          // A first signed count can make a live product public even when it moves no stock.
          await announceStockChange(tx, l.variantId)
        }
        const signed = { ...report, approval: { signedName: approval.signedName.trim(), approvedById: change.actor.id, approvedAt: now.toISOString(), acceptedSkus: approval.acceptedSkus, statement: "The counts are a true physical count, and every discrepancy listed was checked and accepted." } }
        await tx.stocktake.update({ where: { id }, data: { status: "approved", approvedById: change.actor.id, approvedAt: now, signedName: approval.signedName.trim(), report: signed } })
        await recordAdminEvent(tx, {
          action: "stocktake.approved",
          actor: change.actor,
          entity: { type: "stocktake", id },
          reason: approval.reason,
          after: { lines: report.lines.length, corrections, signedName: approval.signedName.trim() },
          correlationId: change.correlationId,
        })
      },
      { timeout: 60_000 },
    )
  } catch (error) {
    if (error instanceof InsufficientStockError) throw new ApiError(409, "conflict", "a count is lower than the units held for paid or pending orders; resolve those orders first")
    throw error
  }
  return loadStocktake(database, id)
}
