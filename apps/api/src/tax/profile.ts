// GST configuration (Stage 12.05). A tax profile holds the seller's GST registration (GSTIN and the
// state it is registered in), whether catalogue prices include GST (decision 014, proposed), and the
// HSN code and GST rate for every tax category used on variants. Tax amounts themselves are 12.06.
//
// Draft      an owner (settings.manage) enters and edits the values. Nothing here invents a rate or an
//            HSN code: no profile exists until the owner creates one, and none ships with the code.
// Approved   the owner signs it: the tax advisor's sign-off reference, a typed full name and the
//            statement that the values were checked by a qualified tax advisor. Approval checks the
//            profile is complete: a valid GSTIN (format, checksum, and its state digits match the seller
//            state), at least one rate, and a rate for every tax category on a sellable variant. From
//            then on the profile never changes (database trigger); a change is a new draft.
// Active     only an approved profile can be activated (checked here and by the database), one at a
//            time; activating one retires the previous. Every step is audited.
// Live sales taxReadiness lists what blocks selling: no active approved profile, or a sellable variant
//            whose tax category is unassigned or has no rate in it. In production an unapproved profile
//            is never used (taxProfileFor); outside production a draft may be used for test quotes and is
//            marked unapproved.
import type { AppEnvironment } from "@chaanavya/shared/config/env"
import { ApiError } from "../admin/api.ts"
import { recordAdminEvent, type AdminActor } from "../audit/catalogue.ts"
import { stateCodeOf, type IndianStateCode } from "../checkout/region.ts"
import type { Db, Tx } from "../db/client.ts"
import { computeTax } from "./compute.ts"

type Staff = AdminActor & { kind: "staff" }
export type TaxChange = { actor: Staff; correlationId: string }

export const TAX_CATEGORY = /^[a-z0-9_]{1,40}$/
export const HSN_CODE = /^([0-9]{4}|[0-9]{6}|[0-9]{8})$/
export const MAX_RATE_BASIS_POINTS = 4000
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GST state codes (the first two digits of a GSTIN) for each ISO 3166-2:IN code. */
export const GST_STATE_CODES: Readonly<Record<IndianStateCode, readonly string[]>> = {
  "IN-JK": ["01"], "IN-HP": ["02"], "IN-PB": ["03"], "IN-CH": ["04"], "IN-UK": ["05"], "IN-HR": ["06"], "IN-DL": ["07"], "IN-RJ": ["08"],
  "IN-UP": ["09"], "IN-BR": ["10"], "IN-SK": ["11"], "IN-AR": ["12"], "IN-NL": ["13"], "IN-MN": ["14"], "IN-MZ": ["15"], "IN-TR": ["16"],
  "IN-ML": ["17"], "IN-AS": ["18"], "IN-WB": ["19"], "IN-JH": ["20"], "IN-OD": ["21"], "IN-CG": ["22"], "IN-MP": ["23"], "IN-GJ": ["24"],
  // Daman and Diu (25) and Dadra and Nagar Haveli (26) merged in 2020; registrations under both codes exist.
  "IN-DH": ["25", "26"], "IN-MH": ["27"], "IN-KA": ["29"], "IN-GA": ["30"], "IN-LD": ["31"], "IN-KL": ["32"], "IN-TN": ["33"], "IN-PY": ["34"],
  "IN-AN": ["35"], "IN-TG": ["36"], "IN-AP": ["37"], "IN-LA": ["38"],
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Whether a GSTIN's last character is the right check character for the first fourteen. */
export function gstinChecksumValid(gstin: string) {
  if (gstin.length !== 15) return false
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(gstin[i]!)
    if (value < 0) return false
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return ALPHABET[(36 - (sum % 36)) % 36] === gstin[14]
}

/** Problems with a GSTIN for this seller state, or none. */
export function gstinProblem(gstin: string, sellerStateCode: IndianStateCode): string | null {
  if (!GSTIN.test(gstin)) return "invalid"
  if (!gstinChecksumValid(gstin)) return "checksum"
  if (!GST_STATE_CODES[sellerStateCode].includes(gstin.slice(0, 2))) return "state_mismatch"
  return null
}

export type TaxRateInput = { taxCategory: string; hsnCode: string; rateBasisPoints: number }
export type TaxProfileInput = { sellerStateCode: IndianStateCode; gstin: string | null; pricesIncludeTax: boolean; note: string; rates: TaxRateInput[] }

/** Checks a draft from a request. A draft may still lack its GSTIN; approval needs it. */
export function parseTaxProfile(body: Record<string, unknown>): TaxProfileInput {
  const problems: Record<string, string> = {}
  const state = typeof body.sellerStateCode === "string" ? stateCodeOf(body.sellerStateCode) : null
  if (!state) problems.sellerStateCode = body.sellerStateCode === undefined || body.sellerStateCode === "" ? "required" : "invalid"
  let gstin: string | null = null
  if (body.gstin !== undefined && body.gstin !== null && body.gstin !== "") {
    if (typeof body.gstin !== "string") problems.gstin = "invalid"
    else {
      gstin = body.gstin.trim().toUpperCase()
      const problem = state ? gstinProblem(gstin, state) : GSTIN.test(gstin) ? null : "invalid"
      if (problem) problems.gstin = problem
    }
  }
  const pricesIncludeTax = body.pricesIncludeTax === undefined ? true : body.pricesIncludeTax
  if (typeof pricesIncludeTax !== "boolean") problems.pricesIncludeTax = "invalid"
  const note = typeof body.note === "string" ? body.note.trim() : ""
  if (note.length > 500) problems.note = "too_long"
  const rates: TaxRateInput[] = []
  if (!Array.isArray(body.rates)) problems.rates = "invalid"
  else if (body.rates.length > 200) problems.rates = "too_many"
  else {
    const seen = new Set<string>()
    body.rates.forEach((raw, i) => {
      const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
      const taxCategory = typeof r.taxCategory === "string" ? r.taxCategory.trim().toLowerCase() : ""
      const hsnCode = typeof r.hsnCode === "string" ? r.hsnCode.trim() : ""
      const rate = r.rateBasisPoints
      if (!TAX_CATEGORY.test(taxCategory) || taxCategory === "unassigned") problems[`rates.${i}.taxCategory`] = "invalid"
      else if (seen.has(taxCategory)) problems[`rates.${i}.taxCategory`] = "duplicate"
      seen.add(taxCategory)
      if (!HSN_CODE.test(hsnCode)) problems[`rates.${i}.hsnCode`] = "invalid"
      if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > MAX_RATE_BASIS_POINTS) problems[`rates.${i}.rateBasisPoints`] = "invalid"
      rates.push({ taxCategory, hsnCode, rateBasisPoints: rate as number })
    })
  }
  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "check the highlighted tax settings", problems)
  return { sellerStateCode: state!, gstin, pricesIncludeTax: pricesIncludeTax as boolean, note, rates }
}

const INCLUDE = { rates: { orderBy: { taxCategory: "asc" as const }, select: { taxCategory: true, hsnCode: true, rateBasisPoints: true } } }

type ProfileRow = {
  id: string; status: string; active: boolean; sellerStateCode: string; gstin: string | null; pricesIncludeTax: boolean; note: string
  approvedById: string | null; approvedAt: Date | null; signedName: string | null; advisorReference: string | null; activatedAt: Date | null; retiredAt: Date | null; createdAt: Date; updatedAt: Date
  rates: TaxRateInput[]
}

export function taxProfileView(p: ProfileRow) {
  return {
    id: p.id,
    status: p.status as "draft" | "approved" | "retired",
    active: p.active,
    sellerStateCode: p.sellerStateCode,
    gstin: p.gstin,
    pricesIncludeTax: p.pricesIncludeTax,
    note: p.note,
    rates: p.rates,
    approval: p.approvedAt ? { approvedById: p.approvedById, approvedAt: p.approvedAt.toISOString(), signedName: p.signedName, advisorReference: p.advisorReference } : null,
    activatedAt: p.activatedAt?.toISOString() ?? null,
    retiredAt: p.retiredAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

const notFound = () => new ApiError(404, "not_found", "not found")

async function load(tx: Db | Tx, id: string, lock = false) {
  if (!UUID.test(id)) throw notFound()
  if (lock) await tx.$queryRaw`SELECT id FROM tax_profile WHERE id = ${id}::uuid FOR UPDATE`
  const row = await tx.taxProfile.findUnique({ where: { id }, include: INCLUDE })
  if (!row) throw notFound()
  return row
}

export async function listTaxProfiles(db: Db) {
  const rows = await db.taxProfile.findMany({ orderBy: [{ active: "desc" }, { createdAt: "desc" }], take: 50, include: INCLUDE })
  return rows.map(taxProfileView)
}

export async function createTaxProfile(db: Db, body: Record<string, unknown>, change: TaxChange) {
  const input = parseTaxProfile(body)
  return db.$transaction(async tx => {
    const row = await tx.taxProfile.create({
      data: { sellerStateCode: input.sellerStateCode, gstin: input.gstin, pricesIncludeTax: input.pricesIncludeTax, note: input.note, createdById: change.actor.id, rates: { create: input.rates } },
      include: INCLUDE,
    })
    await recordAdminEvent(tx, { action: "tax_profile.created", actor: change.actor, entity: { type: "tax_profile", id: row.id }, reason: "", correlationId: change.correlationId, after: { sellerStateCode: row.sellerStateCode, rates: row.rates.length } })
    return taxProfileView(row)
  })
}

/** Replaces a draft's values and rates. An approved or retired profile cannot change. */
export async function updateTaxProfile(db: Db, id: string, body: Record<string, unknown>, change: TaxChange) {
  const input = parseTaxProfile(body)
  return db.$transaction(async tx => {
    const current = await load(tx, id, true)
    if (current.status !== "draft") throw new ApiError(409, "conflict", "an approved tax profile cannot change; create a new draft", { status: current.status })
    await tx.taxRate.deleteMany({ where: { profileId: id } })
    const row = await tx.taxProfile.update({
      where: { id },
      data: { sellerStateCode: input.sellerStateCode, gstin: input.gstin, pricesIncludeTax: input.pricesIncludeTax, note: input.note, rates: { create: input.rates } },
      include: INCLUDE,
    })
    await recordAdminEvent(tx, { action: "tax_profile.updated", actor: change.actor, entity: { type: "tax_profile", id }, reason: "", correlationId: change.correlationId, after: { sellerStateCode: row.sellerStateCode, rates: row.rates.length } })
    return taxProfileView(row)
  })
}

/** Tax categories on variants that can be sold (live product, variant not archived), other than unassigned. */
async function sellableCategories(tx: Db | Tx) {
  const rows = await tx.productVariant.findMany({ where: { archivedAt: null, product: { status: "active" } }, distinct: ["taxCategory"], select: { taxCategory: true } })
  return rows.map(r => r.taxCategory).sort()
}

/** What stops this profile from being approved: a list of field problems, empty when complete. */
async function completeness(tx: Db | Tx, profile: { sellerStateCode: string; gstin: string | null; rates: TaxRateInput[] }) {
  const problems: Record<string, string> = {}
  const state = stateCodeOf(profile.sellerStateCode)
  if (!state) problems.sellerStateCode = "invalid"
  if (!profile.gstin) problems.gstin = "required"
  else if (state) {
    const problem = gstinProblem(profile.gstin, state)
    if (problem) problems.gstin = problem
  }
  if (profile.rates.length === 0) problems.rates = "required"
  const mapped = new Set(profile.rates.map(r => r.taxCategory))
  for (const category of await sellableCategories(tx)) {
    if (category === "unassigned") problems["variants.unassigned"] = "a sellable variant has no tax category"
    else if (!mapped.has(category)) problems[`rates.${category}`] = "missing"
  }
  return problems
}

export type TaxApproval = { signedName: string; advisorReference: string; statement: boolean; reason: string }

/** The owner signs a complete draft with the tax advisor's reference. It never changes afterwards. */
export async function approveTaxProfile(db: Db, id: string, approval: TaxApproval, change: TaxChange) {
  const signedName = approval.signedName.trim()
  const advisorReference = approval.advisorReference.trim()
  const problems: Record<string, string> = {}
  if (!approval.statement) problems.statement = "required"
  if (signedName.length < 3 || signedName.length > 120) problems.signedName = "required"
  if (advisorReference.length < 5 || advisorReference.length > 300) problems.advisorReference = "required"
  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "confirm the advisor's sign-off, give its reference and type your full name", problems)
  return db.$transaction(async tx => {
    const current = await load(tx, id, true)
    if (current.status !== "draft") throw new ApiError(409, "conflict", "only a draft can be approved", { status: current.status })
    const missing = await completeness(tx, current)
    if (Object.keys(missing).length > 0) throw new ApiError(409, "conflict", "the tax profile is incomplete", missing)
    const row = await tx.taxProfile.update({
      where: { id },
      data: { status: "approved", approvedById: change.actor.id, approvedAt: new Date(), signedName, advisorReference },
      include: INCLUDE,
    })
    await recordAdminEvent(tx, { action: "tax_profile.approved", actor: change.actor, entity: { type: "tax_profile", id }, reason: approval.reason, correlationId: change.correlationId, after: { signedName, advisorReference, rates: row.rates.length } })
    return taxProfileView(row)
  })
}

/** Makes an approved profile the one checkout uses; the previous active profile is retired. */
export async function activateTaxProfile(db: Db, id: string, reason: string, change: TaxChange) {
  return db.$transaction(async tx => {
    // One activation at a time: lock every profile row that is or may become active.
    await tx.$queryRaw`SELECT id FROM tax_profile WHERE active OR id = ${UUID.test(id) ? id : "00000000-0000-0000-0000-000000000000"}::uuid FOR UPDATE`
    const current = await load(tx, id)
    if (current.status !== "approved") throw new ApiError(409, "conflict", "only an approved tax profile can be made active", { status: current.status })
    if (current.active) return taxProfileView(current)
    const missing = await completeness(tx, current)
    if (Object.keys(missing).length > 0) throw new ApiError(409, "conflict", "the tax profile no longer covers every sellable variant; approve a new one", missing)
    const previous = await tx.taxProfile.findFirst({ where: { active: true }, select: { id: true } })
    const now = new Date()
    if (previous) await tx.taxProfile.update({ where: { id: previous.id }, data: { active: false, status: "retired", retiredAt: now } })
    const row = await tx.taxProfile.update({ where: { id }, data: { active: true, activatedAt: now }, include: INCLUDE })
    await recordAdminEvent(tx, { action: "tax_profile.activated", actor: change.actor, entity: { type: "tax_profile", id }, reason, correlationId: change.correlationId, before: { activeProfileId: previous?.id ?? null }, after: { activeProfileId: id } })
    return taxProfileView(row)
  })
}

export type TaxBlocker = { code: "no_active_profile" | "unassigned_category" | "unmapped_category"; message: string; taxCategory?: string }

/** What blocks live sales for tax reasons; empty when an approved, active profile covers every sellable variant. */
export async function taxReadiness(db: Db | Tx) {
  const blockers: TaxBlocker[] = []
  const active = await db.taxProfile.findFirst({ where: { active: true, status: "approved" }, include: INCLUDE })
  if (!active) blockers.push({ code: "no_active_profile", message: "No approved tax profile is active: the owner must approve one with the tax advisor's sign-off." })
  const mapped = new Set(active?.rates.map(r => r.taxCategory) ?? [])
  for (const category of await sellableCategories(db)) {
    if (category === "unassigned") blockers.push({ code: "unassigned_category", message: "A sellable variant has no tax category.", taxCategory: category })
    else if (active && !mapped.has(category)) blockers.push({ code: "unmapped_category", message: `Tax category ${category} has no HSN code or rate in the active profile.`, taxCategory: category })
  }
  return { ready: blockers.length === 0, profileId: active?.id ?? null, blockers }
}

/** Refuses a live sale while tax configuration is missing. Checkout calls it before taking an order. */
export async function assertTaxReadyForSale(db: Db | Tx) {
  const readiness = await taxReadiness(db)
  if (!readiness.ready) throw new ApiError(409, "conflict", "sales are closed until the tax configuration is approved", Object.fromEntries(readiness.blockers.map(b => [b.taxCategory ? `tax.${b.taxCategory}` : "tax", b.code])))
  return readiness
}

/**
 * The profile tax is worked out with. Production: only the active approved profile, else null (sales
 * blocked). Elsewhere: the active approved profile, else the newest draft, marked unapproved, so test
 * quotes can run before real values exist.
 */
export async function taxProfileFor(db: Db | Tx, environment: AppEnvironment) {
  const active = await db.taxProfile.findFirst({ where: { active: true, status: "approved" }, include: INCLUDE })
  if (active) return { profile: taxProfileView(active), approved: true as const }
  if (environment === "production") return null
  const draft = await db.taxProfile.findFirst({ where: { status: "draft" }, orderBy: { createdAt: "desc" }, include: INCLUDE })
  return draft ? { profile: taxProfileView(draft), approved: false as const } : null
}

/**
 * GST for a bag with the profile this environment may use (Stage 12.06): in production only the
 * active approved profile; elsewhere a draft for test quotes, marked unapproved in every line's
 * classification. No usable profile: 409, sales closed.
 */
export async function taxForBag(db: Db | Tx, environment: AppEnvironment, input: Omit<Parameters<typeof computeTax>[0], "profile">) {
  const found = await taxProfileFor(db, environment)
  if (!found) throw new ApiError(409, "conflict", "sales are closed until the tax configuration is approved", { tax: "no_active_profile" })
  const { profile, approved } = found
  return computeTax({ ...input, profile: { id: profile.id, approved, sellerStateCode: profile.sellerStateCode, pricesIncludeTax: profile.pricesIncludeTax, rates: profile.rates } })
}
