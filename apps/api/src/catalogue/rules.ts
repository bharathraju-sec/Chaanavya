// Catalogue rules (Stage 08): field validation, variant option keys and the publish checks. Pure
// functions, so the API, the CSV import and the tests share exactly the same rules.
import { ApiError } from "../admin/api.ts"

export const SHIPPING_RESTRICTIONS = ["none", "fragrance_liquid", "jewellery_high_value"] as const
export type ShippingRestriction = (typeof SHIPPING_RESTRICTIONS)[number]

/** Option names staff can use, in display order. */
export const OPTION_NAMES = ["Size", "Colour", "Volume", "Material"] as const
export type OptionName = (typeof OPTION_NAMES)[number]
export const MAX_OPTIONS = 3
export const MAX_VARIANTS = 100

/** Storefront categories with extra publish rules (their handles are fixed page URLs). */
export const APPAREL_COLLECTIONS = ["dresses", "ethnic-festive"]
export const REQUIRED_RESTRICTION: Readonly<Record<string, ShippingRestriction>> = { fragrance: "fragrance_liquid", jewellery: "jewellery_high_value" }

/** What the publisher confirms before a product goes live. `sizing` only for apparel. */
export const CHECKLIST = {
  claims: "Material, origin and care claims are true and can be backed up",
  pricing: "Prices and compare-at prices are real and final, GST inclusive",
  description: "The description is the final, approved text (not template copy)",
  sizing: "Sizes match the size guide and the garment's measurements",
  shipping: "The shipping restriction is right for couriers",
} as const
export type ChecklistItem = keyof typeof CHECKLIST

export const HANDLE = /^[a-z0-9][a-z0-9-]{0,99}$/
const SKU = /^[A-Z0-9][A-Z0-9._-]{0,63}$/
const TAX_CATEGORY = /^[a-z0-9_]{1,40}$/
const HSN = /^\d{4}(\d{2}){0,2}$/
export const MAX_PRICE_PAISE = BigInt(1_000_000_000) // ₹1 crore

const bad = (field: string, message: string): never => {
  throw new ApiError(400, "invalid_request", message, { [field]: message })
}

export function text(value: unknown, field: string, { min = 0, max }: { min?: number; max: number }) {
  if (value === undefined || value === null) value = ""
  if (typeof value !== "string") bad(field, `${field} must be text`)
  const trimmed = (value as string).trim()
  if (trimmed.length < min) bad(field, min === 1 ? `${field} is required` : `${field} needs at least ${min} characters`)
  if (trimmed.length > max) bad(field, `${field} must be at most ${max} characters`)
  return trimmed
}

export function handleOf(value: unknown, field = "handle") {
  const handle = text(value, field, { min: 1, max: 100 }).toLowerCase()
  if (!HANDLE.test(handle)) bad(field, "use lower-case letters, digits and hyphens, starting with a letter or digit")
  return handle
}

/** A handle suggestion from a title: "Royal Oud 50 ml" becomes "royal-oud-50-ml". */
export const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "product"

export function tagsOf(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 30) bad("tags", "tags must be a list of up to 30")
  return [...new Set((value as unknown[]).map(t => text(t, "tags", { min: 1, max: 40 }).toLowerCase()))]
}

export function restrictionOf(value: unknown): ShippingRestriction | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "string" && (SHIPPING_RESTRICTIONS as readonly string[]).includes(value)) return value as ShippingRestriction
  return bad("shippingRestriction", `shippingRestriction must be one of ${SHIPPING_RESTRICTIONS.join(", ")}`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function idList(value: unknown, field: string, max = 20) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max || !value.every(v => typeof v === "string" && UUID.test(v))) bad(field, `${field} must be a list of up to ${max} IDs`)
  return [...new Set(value as string[])]
}

/** Paise from an integer number or a digit string. Never a float, never negative. */
export function paiseOf(value: unknown, field: string, { optional = false } = {}): bigint | null {
  if ((value === null || value === undefined || value === "") && optional) return null
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw)) return bad(field, `${field} must be a whole number of paise`)
  const paise = BigInt(raw)
  if (paise > MAX_PRICE_PAISE) bad(field, `${field} is above the ₹1 crore limit`)
  return paise
}

/** "1,999.50" or "1999" rupees to paise, by string arithmetic (CSV import). */
export function rupeesToPaise(value: string, field: string): bigint {
  const clean = value.replace(/,/g, "").trim()
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(clean)
  if (!match) return bad(field, `${field} must be an amount in rupees like 1999 or 1999.50`)
  const paise = BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"))
  if (paise > MAX_PRICE_PAISE) bad(field, `${field} is above the ₹1 crore limit`)
  return paise
}

export const paiseToRupees = (paise: bigint) => `${paise / BigInt(100)}.${(paise % BigInt(100)).toString().padStart(2, "0")}`

export type OptionDefinition = { name: OptionName; values: string[] }
export type VariantInput = {
  id: string | null
  options: Record<string, string>
  sku: string
  pricePaise: bigint
  compareAtPricePaise: bigint | null
  taxCategory: string
  hsnCode: string | null
  weightGrams: number | null
  /** One of the product's photos shown for this variant. */
  mediaId: string | null
}

export function optionDefinitions(value: unknown): OptionDefinition[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) bad("options", `up to ${MAX_OPTIONS} options`)
  const seen = new Set<string>()
  return (value as unknown[]).map((raw, i) => {
    const option = (raw ?? {}) as { name?: unknown; values?: unknown }
    const name = OPTION_NAMES.find(n => n.toLowerCase() === String(option.name ?? "").trim().toLowerCase())
    if (!name) return bad(`options.${i}.name`, `option names are ${OPTION_NAMES.join(", ")}`)
    if (seen.has(name)) bad(`options.${i}.name`, `${name} is listed twice`)
    seen.add(name)
    if (!Array.isArray(option.values) || option.values.length === 0 || option.values.length > 30) bad(`options.${i}.values`, "each option needs 1 to 30 values")
    const values = (option.values as unknown[]).map(v => text(v, `options.${i}.values`, { min: 1, max: 40 }))
    if (new Set(values.map(v => v.toLowerCase())).size !== values.length) bad(`options.${i}.values`, `${name} has a value twice`)
    return { name, values }
  })
}

/** Stable key for a variant's option combination, e.g. "colour=merlot|size=m". */
export const optionKeyOf = (options: Record<string, string>) =>
  Object.entries(options)
    .map(([name, value]) => `${name.toLowerCase()}=${value.trim().toLowerCase()}`)
    .sort()
    .join("|") || "default"

export function variantInputs(value: unknown, options: OptionDefinition[]): VariantInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VARIANTS) bad("variants", `a product needs 1 to ${MAX_VARIANTS} variants`)
  const keys = new Set<string>()
  const skus = new Set<string>()
  return (value as unknown[]).map((raw, i) => {
    const v = (raw ?? {}) as Record<string, unknown>
    const field = (name: string) => `variants.${i}.${name}`
    const id = v.id === undefined || v.id === null ? null : typeof v.id === "string" && UUID.test(v.id) ? v.id : bad(field("id"), "unknown variant")
    const given = (v.options ?? {}) as Record<string, unknown>
    if (typeof given !== "object" || Array.isArray(given)) bad(field("options"), "options must be an object")
    const chosen: Record<string, string> = {}
    for (const option of options) {
      const pick = Object.entries(given).find(([name]) => name.toLowerCase() === option.name.toLowerCase())?.[1]
      const match = option.values.find(value => value.toLowerCase() === String(pick ?? "").trim().toLowerCase())
      if (!match) bad(field("options"), `choose a ${option.name} from ${option.values.join(", ")}`)
      chosen[option.name] = match as string
    }
    if (Object.keys(given).length !== options.length) bad(field("options"), "options do not match the product's options")
    const key = optionKeyOf(chosen)
    if (keys.has(key)) bad(field("options"), `two variants have the same options (${Object.values(chosen).join(" / ") || "default"})`)
    keys.add(key)
    const sku = text(v.sku, field("sku"), { min: 1, max: 64 }).toUpperCase()
    if (!SKU.test(sku)) bad(field("sku"), "SKUs use letters, digits, dots, hyphens and underscores")
    if (skus.has(sku)) bad(field("sku"), `SKU ${sku} is used twice`)
    skus.add(sku)
    const pricePaise = paiseOf(v.pricePaise, field("pricePaise")) as bigint
    const compareAtPricePaise = paiseOf(v.compareAtPricePaise, field("compareAtPricePaise"), { optional: true })
    if (compareAtPricePaise !== null && compareAtPricePaise <= pricePaise) bad(field("compareAtPricePaise"), "the compare-at price must be higher than the price")
    const taxCategory = v.taxCategory === undefined || v.taxCategory === null || v.taxCategory === "" ? "unassigned" : text(v.taxCategory, field("taxCategory"), { min: 1, max: 40 }).toLowerCase()
    if (!TAX_CATEGORY.test(taxCategory)) bad(field("taxCategory"), "tax categories use lower-case letters, digits and underscores")
    const hsnCode = v.hsnCode === undefined || v.hsnCode === null || v.hsnCode === "" ? null : text(v.hsnCode, field("hsnCode"), { min: 4, max: 8 })
    if (hsnCode !== null && !HSN.test(hsnCode)) bad(field("hsnCode"), "HSN codes have 4, 6 or 8 digits")
    const weightGrams = v.weightGrams === undefined || v.weightGrams === null || v.weightGrams === "" ? null : Number(v.weightGrams)
    if (weightGrams !== null && (!Number.isInteger(weightGrams) || weightGrams < 1 || weightGrams > 100_000)) bad(field("weightGrams"), "weight must be 1 to 100000 grams")
    const mediaId = v.mediaId === undefined || v.mediaId === null || v.mediaId === "" ? null : typeof v.mediaId === "string" && UUID.test(v.mediaId) ? v.mediaId : bad(field("mediaId"), "unknown photo")
    return { id, options: chosen, sku, pricePaise, compareAtPricePaise, taxCategory, hsnCode, weightGrams, mediaId }
  })
}

export const variantTitle = (options: Record<string, string>, order: readonly OptionDefinition[]) => order.map(o => options[o.name]).join(" / ") || "Default"

// ---- publishing ----------------------------------------------------------------------------

export type PublishCandidate = {
  title: string
  handle: string
  description: string
  shippingRestriction: ShippingRestriction | null
  collections: string[]
  variants: { sku: string; pricePaise: bigint; compareAtPricePaise: bigint | null; taxCategory: string; selectedOptions: { name: string; value: string }[] }[]
  media: { status: string; altText: string | null }[]
}

export type Blocker = { code: string; message: string }

/** Synthetic fixtures (prisma/seed.mjs) and placeholder data can never go live. */
export const isDemonstration = (p: Pick<PublishCandidate, "title" | "handle" | "variants">) => /synthetic|placeholder/i.test(`${p.title} ${p.handle}`) || p.variants.some(v => v.sku.startsWith("SYN-"))

export const isApparel = (collections: readonly string[]) => collections.some(c => APPAREL_COLLECTIONS.includes(c))

/** Checklist items this product needs confirmed. */
export const checklistFor = (collections: readonly string[]): ChecklistItem[] => (Object.keys(CHECKLIST) as ChecklistItem[]).filter(item => item !== "sizing" || isApparel(collections))

/** Everything that stops a product from going live; empty when it may be published. */
export function publishBlockers(p: PublishCandidate): Blocker[] {
  const blockers: Blocker[] = []
  const add = (code: string, message: string) => blockers.push({ code, message })
  if (isDemonstration(p)) add("demonstration", "Synthetic and placeholder products cannot be published.")
  if (p.description.trim().length < 40) add("description", "Write the product description (at least 40 characters).")
  if (p.collections.length === 0) add("collections", "Add the product to at least one collection.")
  if (p.variants.length === 0) add("variants", "Add at least one variant with a SKU and price.")
  for (const v of p.variants) {
    if (v.pricePaise <= BigInt(0)) add("price", `${v.sku}: set a price above zero.`)
    if (v.taxCategory === "unassigned") add("tax", `${v.sku}: choose the tax category (decision 014).`)
  }
  const visible = p.media.filter(m => m.status === "approved")
  if (visible.length === 0) add("media", "Approve at least one photo.")
  if (visible.some(m => !m.altText?.trim())) add("alt_text", "Every approved photo needs a description (alt text).")
  if (p.media.some(m => m.status === "pending")) add("media_pending", "Approve or reject the photos waiting for review.")
  if (p.shippingRestriction === null) add("shipping", "Choose the shipping restriction.")
  for (const [collection, needed] of Object.entries(REQUIRED_RESTRICTION)) {
    if (p.collections.includes(collection) && p.shippingRestriction !== needed) add("shipping", `Products in ${collection} need the ${needed.replaceAll("_", " ")} shipping restriction.`)
  }
  if (isApparel(p.collections) && p.variants.some(v => !v.selectedOptions.some(o => o.name === "Size"))) add("sizing", "Apparel needs a Size option on every variant.")
  return blockers
}

export function checklistOf(value: unknown, needed: ChecklistItem[]) {
  const given = (value ?? {}) as Record<string, unknown>
  const missing = needed.filter(item => given[item] !== true)
  if (missing.length) throw new ApiError(400, "invalid_request", "confirm every item of the publish checklist", Object.fromEntries(missing.map(item => [`checklist.${item}`, CHECKLIST[item]])))
  return Object.fromEntries(needed.map(item => [item, true]))
}
