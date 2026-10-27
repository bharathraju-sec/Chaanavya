// CHV-S12-M05: GST configuration (apps/api/src/tax/profile.ts, /api/admin/tax). An unapproved tax
// profile can never become production-active: activation needs an owner's signed approval with the tax
// advisor's reference, the database refuses an active or approved profile without it, production never
// falls back to a draft, and until an approved profile covers every sellable variant, live sales are
// blocked. Approved profiles never change. GSTINs here are synthetic (made-up PAN, valid check
// character); no real rate or HSN code is asserted as correct.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, call, setup, staffWithMfa } from "../auth/helpers.mjs"

let ctx, tax, owner, admin, staff

const GSTIN_KA = "29AAAAA0000A1ZY"
const GSTIN_MH = "27AAAAA0000A1Z2"
const api = (method, path, { jar, body } = {}) => call(ctx.routes.me.GET, `/api/admin/tax${path}`, { method, jar, body })
const draft = (overrides = {}) => ({ sellerStateCode: "IN-KA", gstin: GSTIN_KA, pricesIncludeTax: true, rates: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }], ...overrides })
const approval = (overrides = {}) => ({ statement: true, advisorReference: "Synthetic advisor opinion ref TEST-1", signedName: "Synthetic Owner", reason: "advisor signed off", ...overrides })
const create = async (body = draft()) => {
  const res = await api("POST", "/profiles", { jar: owner.jar, body })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}
const approve = (id, body = approval()) => api("POST", `/profiles/${id}/approve`, { jar: owner.jar, body })
const activate = id => api("POST", `/profiles/${id}/activate`, { jar: owner.jar, body: { reason: "go live with the signed profile" } })
const activeCount = () => ctx.db.taxProfile.count({ where: { active: true } })

async function sellable(taxCategory, handle) {
  await ctx.db.product.create({ data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory }] } } })
}

before(async () => {
  ctx = await setup("chaanavya_test_s12_tax_profile")
  tax = await apiModule("tax/profile")
  owner = await staffWithMfa(ctx, "s12.owner@example.com", "OWNER")
  admin = await staffWithMfa(ctx, "s12.admin@example.com", "ADMIN")
  staff = await staffWithMfa(ctx, "s12.staff@example.com", "STAFF")
  await sellable("apparel_cotton", "fixture-tax-kurta")
})
after(() => ctx?.teardown())

describe("CHV-S12-M05 nothing is live without an approved profile", () => {
  test("with no profile, live sales are blocked and production has no profile to use", async () => {
    const readiness = await api("GET", "/readiness", { jar: owner.jar })
    assert.equal(readiness.status, 200)
    assert.equal(readiness.json.data.ready, false)
    assert.deepEqual(readiness.json.data.blockers.map(b => b.code), ["no_active_profile"])
    await assert.rejects(tax.assertTaxReadyForSale(ctx.db), error => error.status === 409)
    assert.equal(await tax.taxProfileFor(ctx.db, "production"), null)
  })

  test("a draft cannot be activated, and production never falls back to it", async () => {
    const d = await create()
    const refused = await activate(d.id)
    assert.equal(refused.status, 409)
    assert.deepEqual(refused.json.error.fields, { status: "draft" })
    assert.equal(await activeCount(), 0)
    assert.equal(await tax.taxProfileFor(ctx.db, "production"), null, "production ignores drafts")
    const dev = await tax.taxProfileFor(ctx.db, "development")
    assert.equal(dev.approved, false, "outside production a draft is usable for test quotes, marked unapproved")
    assert.equal(dev.profile.id, d.id)
    assert.equal((await tax.taxReadiness(ctx.db)).ready, false)
  })

  test("the database refuses an active or approved profile that was never signed", async () => {
    const d = await create()
    await assert.rejects(ctx.db.taxProfile.update({ where: { id: d.id }, data: { active: true, activatedAt: new Date() } }), "an active draft")
    await assert.rejects(ctx.db.taxProfile.update({ where: { id: d.id }, data: { status: "approved" } }), "approved without a signature")
    await assert.rejects(ctx.db.taxProfile.update({ where: { id: d.id }, data: { status: "approved", approvedById: d.id, approvedAt: new Date(), signedName: "Synthetic Owner", advisorReference: "" } }), "approved without the advisor's reference")
    assert.equal((await ctx.db.taxProfile.findUniqueOrThrow({ where: { id: d.id } })).status, "draft")
  })

  test("only the owner may draft, approve or activate; admin and staff are refused, signed out is 401", async () => {
    const d = await create()
    for (const who of [admin, staff]) {
      assert.equal((await api("POST", "/profiles", { jar: who.jar, body: draft() })).status, 403)
      assert.equal((await api("POST", `/profiles/${d.id}/approve`, { jar: who.jar, body: approval() })).status, 403)
      assert.equal((await api("POST", `/profiles/${d.id}/activate`, { jar: who.jar, body: { reason: "try" } })).status, 403)
      assert.equal((await api("GET", "/readiness", { jar: who.jar })).status, 403)
    }
    assert.equal((await api("GET", "/profiles")).status, 401)
    assert.equal((await ctx.db.taxProfile.findUniqueOrThrow({ where: { id: d.id } })).status, "draft")
  })
})

describe("CHV-S12-M05 approval checks", () => {
  test("approval needs the advisor statement, the advisor's reference, a typed name and a reason", async () => {
    const d = await create()
    assert.deepEqual((await approve(d.id, approval({ statement: false, advisorReference: "", signedName: "A" }))).json.error.fields, { statement: "required", signedName: "required", advisorReference: "required" })
    assert.equal((await approve(d.id, approval({ reason: "" }))).status, 400)
    assert.equal((await ctx.db.taxProfile.findUniqueOrThrow({ where: { id: d.id } })).status, "draft")
  })

  test("an incomplete profile cannot be approved: no GSTIN, no rates, or a sellable category without a rate", async () => {
    const noGstin = await create(draft({ gstin: null }))
    assert.deepEqual((await approve(noGstin.id)).json.error.fields, { gstin: "required" })
    const noRates = await create(draft({ rates: [] }))
    const refusedEmpty = await approve(noRates.id)
    assert.equal(refusedEmpty.status, 409)
    assert.equal(refusedEmpty.json.error.fields.rates, "required")
    await sellable("jewellery_silver", "fixture-tax-ring")
    const partial = await create()
    const refused = await approve(partial.id)
    assert.equal(refused.status, 409)
    assert.deepEqual(refused.json.error.fields, { "rates.jewellery_silver": "missing" })
    await ctx.db.product.update({ where: { handle: "fixture-tax-ring" }, data: { status: "archived" } })
  })

  test("GSTINs must be well formed, carry the right check character and belong to the seller state", async () => {
    const field = async body => (await api("POST", "/profiles", { jar: owner.jar, body })).json.error?.fields
    assert.deepEqual(await field(draft({ gstin: "29AAAAA0000A1ZX" })), { gstin: "checksum" })
    assert.deepEqual(await field(draft({ gstin: GSTIN_MH })), { gstin: "state_mismatch" })
    assert.deepEqual(await field(draft({ gstin: "29AAAAA0000A1Y" })), { gstin: "invalid" })
    assert.deepEqual(await field(draft({ sellerStateCode: "IN-ZZ" })), { sellerStateCode: "invalid" })
    assert.equal((await api("POST", "/profiles", { jar: owner.jar, body: draft({ sellerStateCode: "IN-MH", gstin: GSTIN_MH.toLowerCase() }) })).status, 201, "a Maharashtra GSTIN for a Maharashtra seller, any case")
    assert.equal(tax.gstinChecksumValid("27AAPFU0939F1ZV"), true, "a widely published sample GSTIN passes")
  })

  test("rates must name a real category once, a 4, 6 or 8 digit HSN code and 0% to 40% in whole basis points", async () => {
    const res = await api("POST", "/profiles", { jar: owner.jar, body: draft({ rates: [
      { taxCategory: "unassigned", hsnCode: "6204", rateBasisPoints: 500 },
      { taxCategory: "apparel_cotton", hsnCode: "62041", rateBasisPoints: 4001 },
      { taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 2.5 },
    ] }) })
    assert.equal(res.status, 400)
    assert.deepEqual(res.json.error.fields, { "rates.0.taxCategory": "invalid", "rates.1.hsnCode": "invalid", "rates.1.rateBasisPoints": "invalid", "rates.2.taxCategory": "duplicate", "rates.2.rateBasisPoints": "invalid" })
  })
})

describe("CHV-S12-M05 approved and active", () => {
  let first

  test("a signed, complete profile is approved, then active; sales are ready and production uses it", async () => {
    first = await create()
    const approved = await approve(first.id)
    assert.equal(approved.status, 200, JSON.stringify(approved.json))
    assert.equal(approved.json.data.status, "approved")
    assert.equal(approved.json.data.approval.advisorReference, "Synthetic advisor opinion ref TEST-1")
    assert.equal((await tax.taxReadiness(ctx.db)).ready, false, "approved is not yet active")
    const active = await activate(first.id)
    assert.equal(active.status, 200)
    assert.equal(active.json.data.active, true)
    const readiness = await tax.taxReadiness(ctx.db)
    assert.deepEqual(readiness, { ready: true, profileId: first.id, blockers: [] })
    const used = await tax.taxProfileFor(ctx.db, "production")
    assert.equal(used.approved, true)
    assert.equal(used.profile.id, first.id)
    const actions = (await ctx.db.auditEvent.findMany({ where: { entityId: first.id }, orderBy: { occurredAt: "asc" }, select: { action: true } })).map(e => e.action)
    assert.deepEqual(actions, ["tax_profile.created", "tax_profile.approved", "tax_profile.activated"])
  })

  test("an approved profile never changes: no edit, no rate change, no deletion", async () => {
    assert.equal((await api("PUT", `/profiles/${first.id}`, { jar: owner.jar, body: draft({ rates: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 0 }] }) })).status, 409)
    assert.equal((await approve(first.id)).status, 409, "approving twice is refused")
    await assert.rejects(ctx.db.taxRate.updateMany({ where: { profileId: first.id }, data: { rateBasisPoints: 0 } }))
    await assert.rejects(ctx.db.taxRate.create({ data: { profileId: first.id, taxCategory: "extra", hsnCode: "6204", rateBasisPoints: 0 } }))
    await assert.rejects(ctx.db.taxProfile.update({ where: { id: first.id }, data: { sellerStateCode: "IN-MH" } }))
    await assert.rejects(ctx.db.taxProfile.delete({ where: { id: first.id } }))
    assert.equal((await ctx.db.taxRate.findFirstOrThrow({ where: { profileId: first.id } })).rateBasisPoints, 500)
  })

  test("a new sellable category without a rate blocks sales again until a new profile covers it", async () => {
    await sellable("home_linen", "fixture-tax-towel")
    const readiness = await tax.taxReadiness(ctx.db)
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.blockers.map(b => [b.code, b.taxCategory]), [["unmapped_category", "home_linen"]])
    await assert.rejects(tax.assertTaxReadyForSale(ctx.db), error => error.fields["tax.home_linen"] === "unmapped_category")
    await sellable("unassigned", "fixture-tax-unknown")
    assert.ok((await tax.taxReadiness(ctx.db)).blockers.some(b => b.code === "unassigned_category"))
    await ctx.db.product.update({ where: { handle: "fixture-tax-unknown" }, data: { status: "archived" } })
  })

  test("activating a newer approved profile retires the old one; exactly one is ever active, even in parallel", async () => {
    const rates = [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }, { taxCategory: "home_linen", hsnCode: "6302", rateBasisPoints: 500 }]
    const second = await create(draft({ rates }))
    const third = await create(draft({ rates }))
    assert.equal((await approve(second.id)).status, 200)
    assert.equal((await approve(third.id)).status, 200)
    const results = await Promise.all([activate(second.id), activate(third.id)])
    assert.deepEqual(results.map(r => r.status), [200, 200])
    assert.equal(await activeCount(), 1)
    assert.equal((await ctx.db.taxProfile.findUniqueOrThrow({ where: { id: first.id } })).status, "retired")
    assert.equal((await tax.taxReadiness(ctx.db)).ready, true)
    const winner = await ctx.db.taxProfile.findFirstOrThrow({ where: { active: true } })
    const loser = [second.id, third.id].find(id => id !== winner.id)
    assert.equal((await ctx.db.taxProfile.findUniqueOrThrow({ where: { id: loser } })).status, "retired")
    assert.equal((await activate(first.id)).status, 409, "a retired profile cannot come back")
    await assert.rejects(ctx.db.taxProfile.update({ where: { id: loser }, data: { status: "approved", active: true, activatedAt: new Date() } }), "the database refuses a second active profile or un-retiring")
  })
})
