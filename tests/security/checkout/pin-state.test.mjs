// CHV-S12-M02: PIN and state checks (apps/api/src/checkout/region.ts). A PIN with the right format
// that no courier has confirmed is not deliverable: format and delivery are separate answers, and
// only a courier saying serviceable makes a PIN deliverable. State codes must be one of the 36
// ISO 3166-2:IN codes, checked by the server and by the database.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, setup } from "../auth/helpers.mjs"

let ctx, region, address, ApiError

const ok = { serviceable: true, codAvailable: false, reason: "ok" }
const valid = () => ({ name: "Synthetic Customer", phone: "6000000000", line1: "1 Example Road", city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560001" })

before(async () => {
  ctx = await setup("chaanavya_test_s12_pin_state")
  region = await apiModule("checkout/region")
  address = await apiModule("checkout/address")
  ;({ ApiError } = await apiModule("admin/api"))
})
after(() => ctx?.teardown())

describe("CHV-S12-M02 format is not delivery", () => {
  test("a well-formed PIN no courier has answered for is unknown and not deliverable", () => {
    for (const pin of ["560001", "999999", "100000", "123456"]) {
      assert.deepEqual(region.deliveryCheck(pin), { pinCode: pin, format: "valid", delivery: "unknown", deliverable: false, source: "none" }, pin)
    }
  })

  test("an address with a well-formed but unknown PIN is accepted as an address, yet still not deliverable", () => {
    const parsed = address.parseIndianAddress({ ...valid(), pinCode: "999999" })
    assert.equal(parsed.pinCode, "999999")
    assert.equal(region.deliveryCheck(parsed.pinCode).deliverable, false)
  })

  test("only a courier answer of serviceable makes a PIN deliverable", () => {
    assert.deepEqual(region.deliveryCheck("560001", ok), { pinCode: "560001", format: "valid", delivery: "serviceable", deliverable: true, source: "live" })
    assert.deepEqual(region.deliveryCheck("560001", { serviceable: false, codAvailable: false, reason: "pin_unserviceable" }), { pinCode: "560001", format: "valid", delivery: "not_serviceable", deliverable: false, source: "live" })
    assert.equal(region.deliveryCheck("560001", { serviceable: false, codAvailable: false, reason: "category_restricted" }).delivery, "not_serviceable")
    assert.deepEqual(region.deliveryCheck("560001", { serviceable: false, codAvailable: false, reason: "provider_unavailable" }), { pinCode: "560001", format: "valid", delivery: "unknown", deliverable: false, source: "live" })
    assert.equal(region.deliveryCheck("560001", { serviceable: true, codAvailable: false, reason: "provider_unavailable" }).deliverable, false, "a contradictory answer is not trusted")
  })

  test("a malformed PIN is invalid and never deliverable, even if a courier said yes", () => {
    for (const pin of ["056001", "56001", "5600011", "56000A", " 560001", "560 001", 560001, null, undefined]) {
      const check = region.deliveryCheck(pin, ok)
      assert.equal(check.format, "invalid", String(pin))
      assert.equal(check.deliverable, false, String(pin))
    }
  })
})

describe("CHV-S12-M02 state codes", () => {
  test("the list holds the 36 current states and union territories", () => {
    const codes = Object.keys(region.INDIAN_STATES)
    assert.equal(codes.length, 36)
    assert.equal(new Set(codes).size, 36)
    for (const code of codes) assert.match(code, /^IN-[A-Z]{2}$/)
    for (const code of ["IN-CG", "IN-OD", "IN-TG", "IN-UK", "IN-DH", "IN-LA", "IN-KA", "IN-DL"]) assert.ok(codes.includes(code), code)
  })

  test("known codes are accepted in any case; replaced codes become the current one", () => {
    assert.equal(address.parseIndianAddress({ ...valid(), stateCode: "in-tn" }).stateCode, "IN-TN")
    const replaced = { "IN-CT": "IN-CG", "IN-OR": "IN-OD", "IN-TS": "IN-TG", "IN-UT": "IN-UK", "IN-DD": "IN-DH", "IN-DN": "IN-DH" }
    for (const [old, now] of Object.entries(replaced)) assert.equal(address.parseIndianAddress({ ...valid(), stateCode: old }).stateCode, now, old)
  })

  test("well-shaped but unknown codes, and names instead of codes, are refused", () => {
    for (const stateCode of ["IN-ZZ", "IN-XX", "IN-KK", "KA", "Karnataka", "IN-", "IN-__PROTO__", "IN-CONSTRUCTOR", "__proto__", "toString"]) {
      assert.throws(() => address.parseIndianAddress({ ...valid(), stateCode }), error => error instanceof ApiError && error.fields.stateCode === "invalid", stateCode)
    }
  })

  test("the database refuses a saved address with an unknown or replaced state code", async () => {
    const user = await ctx.db.user.create({ data: { email: "synthetic.state@example.com", emailVerified: true } })
    const row = stateCode => ({ userId: user.id, name: "Synthetic", phone: "+916000000000", line1: "1 Example Road", city: "Mysuru", district: "Mysuru", stateCode, pinCode: "570001" })
    for (const stateCode of ["IN-ZZ", "IN-OR", "IN-TS", "in-ka"]) await assert.rejects(ctx.db.address.create({ data: row(stateCode) }), stateCode)
    assert.equal(await ctx.db.address.count({ where: { userId: user.id } }), 0)
    for (const stateCode of Object.keys(region.INDIAN_STATES)) await ctx.db.address.create({ data: row(stateCode) })
    assert.equal(await ctx.db.address.count({ where: { userId: user.id } }), 36, "every listed code is stored")
  })
})
