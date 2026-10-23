// Offline, read-only conversion of an old Shopify "products_export.csv" (Admin > Products > Export)
// into Chaanavya import files (Stage 09). No Shopify SDK, API or network access: it only reads the
// file you give it and writes three files next to the output prefix.
//
//   node scripts/import/shopify-export.mjs <products_export.csv> <output prefix>
//
//   <prefix>-catalogue.csv   Stage 08 catalogue import format: every product as a DRAFT, handles and
//                            SKUs kept so old links still match. Descriptions are the old text with
//                            HTML removed and must be approved before publishing; prices are the old
//                            Shopify prices and must be confirmed; photos are not imported (upload
//                            them to owned storage, decision 034).
//   <prefix>-count.csv       Stock count sheet: sku, counted (empty: fill it from a physical count),
//                            shopify_quantity (reference only, never used as stock).
//   <prefix>-mapping.json    Old handle and SKU to new handle and SKU, image URLs, skipped rows and why.
//
// Nothing here is trusted as stock or as approved merchandise: the catalogue file creates drafts, and
// stock becomes sellable only through an approved stocktake.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const [input, prefix] = process.argv.slice(2)
if (!input || !prefix) {
  console.error("usage: node scripts/import/shopify-export.mjs <products_export.csv> <output prefix>")
  process.exit(2)
}

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === "") quoted = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      if (ch === "\r" && src[i + 1] === "\n") i++
    } else field += ch
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => r.some(c => c.trim() !== ""))
}

const FORMULA = /^[=+\-@\t\r]/
const cell = v => {
  const s = FORMULA.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
const toCsv = rows => `${rows.map(r => r.map(cell).join(",")).join("\r\n")}\r\n`

const text = readFileSync(input, "utf8")
const rows = parseCsv(text)
const header = rows[0].map(h => h.trim().toLowerCase())
const col = name => header.indexOf(name.toLowerCase())
for (const required of ["Handle", "Variant SKU", "Variant Price"]) {
  if (col(required) < 0) {
    console.error(`not a Shopify products export: the ${required} column is missing`)
    process.exit(1)
  }
}
const get = (r, name) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "")
const plain = html =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
const OPTION = { size: "Size", color: "Colour", colour: "Colour", volume: "Volume", material: "Material" }

const catalogue = [["handle", "title", "description", "product_type", "tags", "collections", "shipping_restriction", "sku", "option1_name", "option1_value", "option2_name", "option2_value", "option3_name", "option3_value", "price", "compare_at_price", "tax_category", "hsn_code", "weight_grams"]]
const count = [["sku", "counted", "shopify_quantity", "note"]]
const mapping = { source: { file: input.split(/[\\/]/).pop(), sha256: createHash("sha256").update(text).digest("hex"), rows: rows.length - 1 }, products: {}, skipped: [] }
const product = {}

for (const [i, r] of rows.slice(1).entries()) {
  const line = i + 2
  const handle = get(r, "Handle").toLowerCase()
  if (!handle) {
    mapping.skipped.push({ line, why: "no handle" })
    continue
  }
  // Shopify repeats the handle on extra image rows: only the first row carries the product fields.
  if (get(r, "Title")) product[handle] = { title: get(r, "Title"), description: plain(get(r, "Body (HTML)")), type: get(r, "Type"), tags: get(r, "Tags").split(",").map(t => t.trim()).filter(Boolean).join(";"), options: [1, 2, 3].map(n => get(r, `Option${n} Name`)) }
  const p = product[handle]
  const entry = (mapping.products[handle] ??= { title: p?.title ?? "", skus: [], images: [] })
  const image = get(r, "Image Src")
  if (image && !entry.images.includes(image)) entry.images.push(image)
  const sku = get(r, "Variant SKU").toUpperCase()
  if (!sku) {
    if (get(r, "Variant Price")) mapping.skipped.push({ line, handle, why: "variant without a SKU: give it a SKU in Shopify or in the catalogue file" })
    continue
  }
  if (!p) {
    mapping.skipped.push({ line, handle, sku, why: "variant row before its product row" })
    continue
  }
  const options = p.options.map((name, n) => ({ name: OPTION[name.toLowerCase()] ?? name, value: get(r, `Option${n + 1} Value`) })).filter(o => o.name && o.name !== "Title" && o.value !== "Default Title")
  const unsupported = options.find(o => !["Size", "Colour", "Volume", "Material"].includes(o.name))
  if (unsupported) mapping.skipped.push({ line, handle, sku, why: `option ${unsupported.name} is not one of Size, Colour, Volume, Material; rename it in the catalogue file` })
  const grams = Number(get(r, "Variant Grams"))
  catalogue.push([
    handle,
    p.title,
    p.description,
    p.type,
    p.tags,
    "",
    "",
    sku,
    ...[0, 1, 2].flatMap(n => [options[n]?.name ?? "", options[n]?.value ?? ""]),
    get(r, "Variant Price"),
    get(r, "Variant Compare At Price"),
    "",
    get(r, "Variant Tax Code").replace(/\D/g, "").slice(0, 8),
    Number.isInteger(grams) && grams > 0 ? String(grams) : "",
  ])
  count.push([sku, "", get(r, "Variant Inventory Qty"), ""])
  entry.skus.push({ sku, newHandle: handle, newSku: sku, shopifyQuantity: get(r, "Variant Inventory Qty") || null })
}

writeFileSync(`${prefix}-catalogue.csv`, toCsv(catalogue))
writeFileSync(`${prefix}-count.csv`, toCsv(count))
writeFileSync(`${prefix}-mapping.json`, `${JSON.stringify(mapping, null, 2)}\n`)
const products = Object.keys(mapping.products).length
console.log(`${products} products, ${catalogue.length - 1} variants written as drafts; ${mapping.skipped.length} rows need attention (see ${prefix}-mapping.json).`)
console.log("Next: fill collections, shipping restriction and tax category, import the catalogue file (drafts), then count the stock physically and import the count sheet as a stocktake.")
