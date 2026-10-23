// Catalogue CSV import and export (Stage 08). One row per variant; product columns repeat on each
// row of the same handle. The import is two steps:
//
//   preview  parses and validates every row against the same rules as the editor and reports all
//            errors and every planned change (new products, new variants, price before and after).
//            Nothing is written. The answer carries a token tied to the file and to the version of
//            every product it touches.
//   commit   repeats the preview inside one transaction and applies it only if there are no errors
//            and the token still matches (nobody changed those products meanwhile). All or nothing.
//
// Safety: stock is never imported (a stock column is an error, and variants get no stock); only new
// products and drafts are written (live and archived products are edited in the admin); variants not
// in the file are left alone; imported products are always drafts.
import { createHash, randomUUID } from "node:crypto"
import { ApiError } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db, Tx } from "../db/client.ts"
import { parseCsv, toCsv } from "./csv.ts"
import type { Change } from "./products.ts"
import { productOptions } from "./products.ts"
import {
  handleOf,
  optionDefinitions,
  optionKeyOf,
  paiseToRupees,
  restrictionOf,
  rupeesToPaise,
  tagsOf,
  text,
  variantInputs,
  variantTitle,
  type OptionDefinition,
  type ShippingRestriction,
  type VariantInput,
} from "./rules.ts"

export const IMPORT_MAX_BYTES = 1024 * 1024
export const IMPORT_MAX_ROWS = 2000

export const COLUMNS = [
  "handle",
  "title",
  "description",
  "product_type",
  "tags",
  "collections",
  "shipping_restriction",
  "sku",
  "option1_name",
  "option1_value",
  "option2_name",
  "option2_value",
  "option3_name",
  "option3_value",
  "price",
  "compare_at_price",
  "tax_category",
  "hsn_code",
  "weight_grams",
] as const
type Column = (typeof COLUMNS)[number]
const PRODUCT_COLUMNS: Column[] = ["title", "description", "product_type", "tags", "collections", "shipping_restriction"]
const STOCK_COLUMN = /stock|quantity|qty|inventory|on_?hand|available/i

export type ImportError = { row: number; field: string; message: string }
type PlannedVariant = { sku: string; action: "create" | "update"; pricePaise: string; beforePricePaise: string | null; title: string }
type PlannedProduct = { handle: string; action: "create" | "update"; title: string; firstRow: number; variants: PlannedVariant[] }

type Group = {
  handle: string
  firstRow: number
  fields: { title: string; description: string; productType: string; tags: string[]; collections: string[]; shippingRestriction: ShippingRestriction | null }
  options: OptionDefinition[]
  variants: (VariantInput & { row: number })[]
  existing: Awaited<ReturnType<typeof loadExisting>>[number] | null
  collectionIds: string[]
}

const sha = (value: string) => createHash("sha256").update(value).digest("base64url")
const messageOf = (error: unknown) => (error instanceof ApiError ? Object.values(error.fields ?? {})[0] ?? error.message : "invalid value")
const fieldOf = (error: unknown, fallback: string) => (error instanceof ApiError ? Object.keys(error.fields ?? {})[0] ?? fallback : fallback)

async function loadExisting(db: Db | Tx, handles: string[]) {
  return db.product.findMany({
    where: { handle: { in: handles } },
    select: { id: true, handle: true, status: true, version: true, variants: { where: { archivedAt: null }, select: { id: true, sku: true, pricePaise: true, selectedOptions: true, optionKey: true, position: true } } },
  })
}

/** Validates the file and plans every change, without writing anything. */
export async function planImport(db: Db | Tx, csv: string) {
  const errors: ImportError[] = []
  if (Buffer.byteLength(csv) > IMPORT_MAX_BYTES) throw new ApiError(413, "invalid_request", "the file is larger than 1 MB")
  let rows: string[][]
  try {
    rows = parseCsv(csv)
  } catch (error) {
    throw new ApiError(400, "invalid_request", `the file is not valid CSV: ${(error as Error).message}`)
  }
  if (rows.length < 2) throw new ApiError(400, "invalid_request", "the file needs a header row and at least one product row")
  if (rows.length - 1 > IMPORT_MAX_ROWS) throw new ApiError(413, "invalid_request", `up to ${IMPORT_MAX_ROWS} rows per file`)
  const header = rows[0].map(h => h.trim().toLowerCase())
  for (const [i, name] of header.entries()) {
    if (STOCK_COLUMN.test(name)) errors.push({ row: 1, field: name, message: "stock is never imported; adjust stock in Inventory" })
    else if (!(COLUMNS as readonly string[]).includes(name)) errors.push({ row: 1, field: name || `column ${i + 1}`, message: "unknown column" })
  }
  if (!header.includes("handle") || !header.includes("sku")) errors.push({ row: 1, field: "header", message: "the handle and sku columns are required" })
  if (errors.length) return { errors, products: [] as PlannedProduct[], token: null, groups: [] as Group[] }

  const get = (row: string[], column: Column) => (row[header.indexOf(column)] ?? "").trim()
  const collections = new Map((await db.collection.findMany({ select: { id: true, handle: true } })).map(c => [c.handle, c.id]))
  const byHandle = new Map<string, { row: number; cells: string[] }[]>()
  for (const [i, cells] of rows.slice(1).entries()) {
    const rowNumber = i + 2
    let handle: string
    try {
      handle = handleOf(get(cells, "handle"))
    } catch (error) {
      errors.push({ row: rowNumber, field: "handle", message: messageOf(error) })
      continue
    }
    byHandle.set(handle, [...(byHandle.get(handle) ?? []), { row: rowNumber, cells }])
  }
  const existing = new Map((await loadExisting(db, [...byHandle.keys()])).map(p => [p.handle, p]))

  const groups: Group[] = []
  for (const [handle, entries] of byHandle) {
    const first = entries[0]
    const found = existing.get(handle) ?? null
    if (found && found.status !== "draft") {
      errors.push({ row: first.row, field: "handle", message: `${handle} is ${found.status === "active" ? "live" : "archived"}; edit it in the admin instead` })
      continue
    }
    for (const entry of entries.slice(1)) {
      for (const column of PRODUCT_COLUMNS) {
        const value = header.includes(column) ? get(entry.cells, column) : ""
        if (value && value !== get(first.cells, column)) errors.push({ row: entry.row, field: column, message: `differs from row ${first.row} for the same handle` })
      }
    }
    const before = errors.length
    const attempt = <T,>(row: number, field: string, run: () => T): T | undefined => {
      try {
        return run()
      } catch (error) {
        errors.push({ row, field: fieldOf(error, field), message: messageOf(error) })
        return undefined
      }
    }
    const title = attempt(first.row, "title", () => text(get(first.cells, "title"), "title", { min: 1, max: 200 }))
    const description = attempt(first.row, "description", () => text(get(first.cells, "description"), "description", { max: 10_000 }))
    const productType = attempt(first.row, "product_type", () => text(get(first.cells, "product_type"), "product_type", { max: 80 }))
    const tags = attempt(first.row, "tags", () => tagsOf(get(first.cells, "tags").split(";").map(t => t.trim()).filter(Boolean)))
    const shippingRestriction = attempt(first.row, "shipping_restriction", () => restrictionOf(get(first.cells, "shipping_restriction")))
    const collectionHandles = get(first.cells, "collections").split(";").map(c => c.trim().toLowerCase()).filter(Boolean)
    for (const c of collectionHandles) if (!collections.has(c)) errors.push({ row: first.row, field: "collections", message: `no collection ${c}` })

    // Options: names from the first row, values collected from every row. Must match the draft's existing variants.
    const optionNames = [1, 2, 3].map(n => get(first.cells, `option${n}_name` as Column)).filter(Boolean)
    const valuesFor = (n: number) => [...new Map(entries.map(e => get(e.cells, `option${n}_value` as Column)).filter(Boolean).map(v => [v.toLowerCase(), v])).values()]
    const keptVariants = (found?.variants ?? []).filter(v => !entries.some(e => get(e.cells, "sku").toUpperCase() === v.sku))
    const keptOptions = productOptions(keptVariants)
    const options = attempt(first.row, "option1_name", () => {
      const defined = optionDefinitions(optionNames.map((name, i) => ({ name, values: [...valuesFor(i + 1), ...(keptOptions.find(o => o.name.toLowerCase() === name.toLowerCase())?.values ?? [])] })))
      if (keptVariants.length && keptOptions.map(o => o.name).join() !== defined.map(o => o.name).join()) throw new ApiError(400, "invalid_request", "options differ from the draft's other variants", { option1_name: `the draft's other variants use ${keptOptions.map(o => o.name).join(", ") || "no options"}` })
      return defined
    })
    const variants: (VariantInput & { row: number })[] = []
    if (options) {
      for (const entry of entries) {
        const names = [1, 2, 3].map(n => get(entry.cells, `option${n}_name` as Column))
        if (names.filter(Boolean).join() !== optionNames.join()) {
          errors.push({ row: entry.row, field: "option1_name", message: `option names must match row ${first.row}` })
          continue
        }
        const picked = Object.fromEntries(options.map((o, i) => [o.name, get(entry.cells, `option${i + 1}_value` as Column)]))
        const price = attempt(entry.row, "price", () => rupeesToPaise(get(entry.cells, "price"), "price"))
        const compare = get(entry.cells, "compare_at_price") ? attempt(entry.row, "compare_at_price", () => rupeesToPaise(get(entry.cells, "compare_at_price"), "compare_at_price")) : null
        if (price === undefined || compare === undefined) continue
        const match = found?.variants.find(v => v.sku === get(entry.cells, "sku").toUpperCase())
        const parsed = attempt(entry.row, "sku", () =>
          variantInputs(
            [{ id: match?.id ?? null, options: picked, sku: get(entry.cells, "sku"), pricePaise: price.toString(), compareAtPricePaise: compare?.toString() ?? null, taxCategory: get(entry.cells, "tax_category"), hsnCode: get(entry.cells, "hsn_code"), weightGrams: get(entry.cells, "weight_grams") }],
            options,
          )[0],
        )
        if (parsed) variants.push({ ...parsed, row: entry.row })
      }
      // Unique SKUs and option combinations across the file's rows and the variants the draft keeps.
      const seenSku = new Map<string, number>()
      const seenKey = new Map<string, number>()
      for (const v of keptVariants) seenKey.set(v.optionKey, 0)
      for (const v of variants) {
        if (seenSku.has(v.sku)) errors.push({ row: v.row, field: "sku", message: `SKU ${v.sku} is also on row ${seenSku.get(v.sku)}` })
        seenSku.set(v.sku, v.row)
        const key = optionKeyOf(v.options)
        if (seenKey.has(key)) errors.push({ row: v.row, field: "option1_value", message: seenKey.get(key) ? `same options as row ${seenKey.get(key)}` : "same options as an existing variant of this draft" })
        seenKey.set(key, v.row)
      }
    }
    if (errors.length > before || !options || title === undefined) continue
    groups.push({
      handle,
      firstRow: first.row,
      fields: { title, description: description ?? "", productType: productType ?? "", tags: tags ?? [], collections: collectionHandles, shippingRestriction: shippingRestriction ?? null },
      options,
      variants,
      existing: found,
      collectionIds: collectionHandles.map(c => collections.get(c)!).filter(Boolean),
    })
  }

  // SKUs already used by other products' active variants.
  const allSkus = groups.flatMap(g => g.variants.map(v => v.sku))
  if (allSkus.length) {
    const taken = await db.productVariant.findMany({ where: { sku: { in: allSkus }, archivedAt: null }, select: { sku: true, productId: true } })
    for (const t of taken) {
      const group = groups.find(g => g.variants.some(v => v.sku === t.sku))!
      if (group.existing?.id !== t.productId) errors.push({ row: group.variants.find(v => v.sku === t.sku)!.row, field: "sku", message: `SKU ${t.sku} is used by another product` })
    }
  }

  const products: PlannedProduct[] = groups.map(g => ({
    handle: g.handle,
    action: g.existing ? "update" : "create",
    title: g.fields.title,
    firstRow: g.firstRow,
    variants: g.variants.map(v => {
      const before = g.existing?.variants.find(e => e.id === v.id)
      return { sku: v.sku, action: before ? "update" : "create", pricePaise: v.pricePaise.toString(), beforePricePaise: before ? before.pricePaise.toString() : null, title: variantTitle(v.options, g.options) }
    }),
  }))
  const fingerprint = JSON.stringify(groups.map(g => [g.handle, g.existing ? g.existing.version : "new"]).sort())
  const token = errors.length ? null : `${sha(csv)}.${sha(fingerprint)}`
  return { errors: errors.sort((a, b) => a.row - b.row), products, token, groups }
}

export function summaryOf(plan: Awaited<ReturnType<typeof planImport>>) {
  return {
    productsCreated: plan.products.filter(p => p.action === "create").length,
    productsUpdated: plan.products.filter(p => p.action === "update").length,
    variantsCreated: plan.products.reduce((n, p) => n + p.variants.filter(v => v.action === "create").length, 0),
    variantsUpdated: plan.products.reduce((n, p) => n + p.variants.filter(v => v.action === "update").length, 0),
  }
}

/** Applies a previewed file in one transaction. */
export async function commitImport(database: Db, csv: string, token: string, change: Change & { reason: string }) {
  return database.$transaction(
    async tx => {
      const plan = await planImport(tx, csv)
      if (plan.errors.length) throw new ApiError(400, "invalid_request", "the file has errors; preview it again", { file: `${plan.errors.length} errors` })
      if (plan.token !== token) throw new ApiError(409, "conflict", "the file or the products it changes are different from the preview; preview it again")
      for (const g of plan.groups) {
        let productId = g.existing?.id
        const fields = { title: g.fields.title, description: g.fields.description, productType: g.fields.productType, tags: g.fields.tags, shippingRestriction: g.fields.shippingRestriction }
        if (productId) {
          const { count } = await tx.product.updateMany({ where: { id: productId, version: g.existing!.version, status: "draft" }, data: { ...fields, version: { increment: 1 } } })
          if (count !== 1) throw new ApiError(409, "conflict", `${g.handle} changed since the preview; preview it again`)
          await recordAdminEvent(tx, { action: "product.updated", actor: change.actor, entity: { type: "product", id: productId }, reason: change.reason, after: { fields: "import", live: false }, correlationId: change.correlationId })
        } else {
          productId = (await tx.product.create({ data: { ...fields, handle: g.handle, status: "draft" } })).id
          await recordAdminEvent(tx, { action: "product.created", actor: change.actor, entity: { type: "product", id: productId }, reason: change.reason, after: { handle: g.handle, status: "draft" }, correlationId: change.correlationId })
        }
        await tx.productCollection.deleteMany({ where: { productId, collectionId: { notIn: g.collectionIds } } })
        for (const [position, collectionId] of g.collectionIds.entries()) {
          await tx.productCollection.upsert({ where: { productId_collectionId: { productId, collectionId } }, update: { position }, create: { productId, collectionId, position } })
        }
        let position = Math.max(-1, ...(g.existing?.variants.map(v => v.position) ?? [])) + 1
        for (const v of g.variants) {
          const data = {
            title: variantTitle(v.options, g.options),
            selectedOptions: g.options.map(o => ({ name: o.name, value: v.options[o.name] })),
            optionKey: optionKeyOf(v.options),
            pricePaise: v.pricePaise,
            compareAtPricePaise: v.compareAtPricePaise,
            taxCategory: v.taxCategory,
            hsnCode: v.hsnCode,
            weightGrams: v.weightGrams,
          }
          if (v.id) await tx.productVariant.update({ where: { id: v.id }, data: { ...data, version: { increment: 1 } } })
          else {
            const variant = await tx.productVariant.create({ data: { ...data, sku: v.sku, productId, position: position++ } })
            await tx.inventoryBalance.create({ data: { variantId: variant.id } })
          }
        }
      }
      const summary = summaryOf(plan)
      await recordAdminEvent(tx, {
        action: "catalogue.imported",
        actor: change.actor,
        entity: { type: "catalogue_import", id: randomUUID() },
        reason: change.reason,
        after: { productsCreated: summary.productsCreated, productsUpdated: summary.productsUpdated, variants: summary.variantsCreated + summary.variantsUpdated },
        correlationId: change.correlationId,
      })
      return summary
    },
    { timeout: 60_000 },
  )
}

/** Every product that is not archived, one row per active variant, in the import format. */
export async function exportCatalogue(db: Db) {
  const products = await db.product.findMany({
    where: { status: { not: "archived" } },
    orderBy: { handle: "asc" },
    include: { collections: { include: { collection: { select: { handle: true } } }, orderBy: { position: "asc" } }, variants: { where: { archivedAt: null }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] } },
  })
  const rows: string[][] = [[...COLUMNS]]
  for (const p of products) {
    const shared = [p.handle, p.title, p.description, p.productType, p.tags.join(";"), p.collections.map(c => c.collection.handle).join(";"), p.shippingRestriction ?? ""]
    const variants = p.variants.length ? p.variants : [null]
    for (const v of variants) {
      const options = Array.isArray(v?.selectedOptions) ? (v.selectedOptions as { name: string; value: string }[]) : []
      const optionCells = [0, 1, 2].flatMap(i => [options[i]?.name ?? "", options[i]?.value ?? ""])
      rows.push([
        ...shared,
        v?.sku ?? "",
        ...optionCells,
        v ? paiseToRupees(v.pricePaise) : "",
        v?.compareAtPricePaise != null ? paiseToRupees(v.compareAtPricePaise) : "",
        v?.taxCategory ?? "",
        v?.hsnCode ?? "",
        v?.weightGrams != null ? String(v.weightGrams) : "",
      ])
    }
  }
  return toCsv(rows)
}
