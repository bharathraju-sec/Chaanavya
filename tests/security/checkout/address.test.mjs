// CHV-S12-M01: Indian shipping addresses (apps/api/src/checkout/address.ts). Invalid mandatory
// address data cannot be saved: the server check refuses it with every problem named, and the
// database refuses it too when the check is bypassed. A guest's address is only ever a snapshot
// and never reaches the address book; a snapshot of a saved address is a plain copy.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, setup } from "../auth/helpers.mjs"

let ctx, address, ApiError

const valid = () => ({
  name: "Synthetic Customer",
  phone: "+91 60000 00000",
  line1: "1 Example Road",
  line2: "Flat 4",
  landmark: null,
  city: "Bengaluru",
  district: "Bengaluru Urban",
  stateCode: "in-ka",
  pinCode: "560001",
})

/** The `fields` of the 400 a bad address gets. */
function problemsOf(body) {
  try {
    address.parseIndianAddress(body)
  } catch (error) {
    assert.ok(error instanceof ApiError, "refused with an ApiError")
    assert.equal(error.status, 400)
    assert.equal(error.code, "invalid_request")
    return error.fields
  }
  assert.fail("the address was accepted")
}

async function customer(email) {
  return ctx.db.user.create({ data: { email, emailVerified: true } })
}

/** A row written straight to the database, skipping the server check. */
const row = (userId, overrides = {}) => ({ userId, name: "Synthetic", phone: "+916000000000", line1: "1 Example Road", city: "Mysuru", district: "Mysuru", stateCode: "IN-KA", pinCode: "570001", ...overrides })

before(async () => {
  ctx = await setup("chaanavya_test_s12_address")
  address = await apiModule("checkout/address")
  ;({ ApiError } = await apiModule("admin/api"))
})
after(() => ctx?.teardown())

describe("CHV-S12-M01 address check", () => {
  test("a complete address is cleaned: E.164 mobile, upper-case state, India, spaces collapsed", () => {
    const out = address.parseIndianAddress({ ...valid(), name: "  Synthetic   Customer ", line2: "   " })
    assert.deepEqual(out, { name: "Synthetic Customer", phone: "+916000000000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560001", country: "IN" })
  })

  test("each mandatory field missing or blank is named as required", () => {
    for (const field of ["name", "phone", "line1", "city", "district", "stateCode", "pinCode"]) {
      for (const empty of [undefined, null, "", "   "]) {
        const body = valid()
        if (empty === undefined) delete body[field]
        else body[field] = empty
        assert.deepEqual(problemsOf(body), { [field]: "required" }, `${field} = ${JSON.stringify(empty)}`)
      }
    }
  })

  test("every problem is reported at once", () => {
    assert.deepEqual(problemsOf({}), { name: "required", phone: "required", line1: "required", city: "required", district: "required", stateCode: "required", pinCode: "required" })
  })

  test("malformed PIN codes are refused", () => {
    for (const pinCode of ["056001", "56001", "5600011", "56000A", "560 001", 560001]) assert.deepEqual(problemsOf({ ...valid(), pinCode }), { pinCode: "invalid" }, String(pinCode))
  })

  test("phones that are not Indian mobiles are refused; usual ways of writing one are accepted", () => {
    for (const phone of ["+910000000000", "5876543210", "98765", "+1 415 555 0100", "044 2222 3333", "+91 98765 432100", "phone"]) assert.deepEqual(problemsOf({ ...valid(), phone }), { phone: "invalid" }, phone)
    for (const phone of ["9876543210", "+919876543210", "919876543210", "09876543210", "+91-98765-43210", "(+91) 98765 43210"]) assert.equal(address.parseIndianAddress({ ...valid(), phone }).phone, "+919876543210", phone)
  })

  test("state codes not shaped IN-XX, other countries, wrong types, control characters and over-long text are refused", () => {
    for (const stateCode of ["KA", "IN-K", "IN-KAR", "US-CA", "IN_KA"]) assert.deepEqual(problemsOf({ ...valid(), stateCode }), { stateCode: "invalid" }, stateCode)
    assert.deepEqual(problemsOf({ ...valid(), country: "US" }), { country: "invalid" })
    assert.deepEqual(problemsOf({ ...valid(), name: ["Synthetic"] }), { name: "invalid" })
    assert.deepEqual(problemsOf({ ...valid(), city: { name: "Bengaluru" } }), { city: "invalid" })
    assert.deepEqual(problemsOf({ ...valid(), line1: "1 Example\u0000Road" }), { line1: "invalid" })
    assert.deepEqual(problemsOf({ ...valid(), name: "A".repeat(101) }), { name: "too_long" })
    assert.deepEqual(problemsOf({ ...valid(), landmark: "B".repeat(201) }), { landmark: "too_long" })
    assert.deepEqual(problemsOf({ ...valid(), district: "C".repeat(101) }), { district: "too_long" })
    for (const body of [null, "address", ["a"], 7]) assert.deepEqual(problemsOf(body), { address: "invalid" })
  })
})

describe("CHV-S12-M01 saving", () => {
  test("a valid address is saved to the customer's address book, cleaned", async () => {
    const user = await customer("synthetic.saved@example.com")
    const saved = await address.saveAddress(ctx.db, user.id, valid())
    const stored = await ctx.db.address.findUniqueOrThrow({ where: { id: saved.id } })
    assert.equal(stored.userId, user.id)
    assert.equal(stored.phone, "+916000000000")
    assert.equal(stored.district, "Bengaluru Urban")
    assert.equal(stored.stateCode, "IN-KA")
    assert.equal(stored.isDefault, false)
  })

  test("an invalid address is refused and nothing is written", async () => {
    const user = await customer("synthetic.refused@example.com")
    for (const bad of [{ ...valid(), district: "" }, { ...valid(), pinCode: "012345" }, { ...valid(), phone: "12345" }, { ...valid(), name: "   " }]) {
      await assert.rejects(address.saveAddress(ctx.db, user.id, bad), error => error instanceof ApiError && error.status === 400)
    }
    assert.equal(await ctx.db.address.count({ where: { userId: user.id } }), 0)
  })

  test("the database refuses invalid mandatory data written directly", async () => {
    const user = await customer("synthetic.direct@example.com")
    const bad = {
      "blank name": { name: "  " },
      "blank line 1": { line1: "" },
      "blank city": { city: " " },
      "blank district": { district: "" },
      "no district": { district: undefined },
      "landline phone": { phone: "+914422223333" },
      "unformatted phone": { phone: "9876543210" },
      "PIN starting 0": { pinCode: "012345" },
      "short PIN": { pinCode: "56001" },
      "state without country prefix": { stateCode: "KA" },
      "other country": { country: "US" },
      "over-long name": { name: "A".repeat(101) },
      "over-long landmark": { landmark: "B".repeat(201) },
    }
    for (const [label, overrides] of Object.entries(bad)) {
      await assert.rejects(ctx.db.address.create({ data: row(user.id, overrides) }), `${label} must be refused`)
    }
    assert.equal(await ctx.db.address.count({ where: { userId: user.id } }), 0)
    await ctx.db.address.create({ data: row(user.id) })
    assert.equal(await ctx.db.address.count({ where: { userId: user.id } }), 1, "the same row with valid data is stored")
  })
})

describe("CHV-S12-M01 guest snapshot and saved address are separate", () => {
  test("a guest's address is checked and returned as a snapshot; the address book is untouched", async () => {
    const before = await ctx.db.address.count()
    const snapshot = address.guestAddressSnapshot(valid())
    assert.deepEqual(Object.keys(snapshot).sort(), ["city", "country", "district", "landmark", "line1", "line2", "name", "phone", "pinCode", "stateCode"])
    assert.equal(await ctx.db.address.count(), before)
    assert.throws(() => address.guestAddressSnapshot({ ...valid(), pinCode: "" }), error => error instanceof ApiError && error.fields.pinCode === "required")
  })

  test("a snapshot of a saved address carries no id or owner and does not follow later edits", async () => {
    const user = await customer("synthetic.snapshot@example.com")
    const saved = await address.saveAddress(ctx.db, user.id, valid(), { isDefault: true })
    const snapshot = address.addressSnapshot(await ctx.db.address.findUniqueOrThrow({ where: { id: saved.id } }))
    for (const key of ["id", "userId", "isDefault", "createdAt", "updatedAt"]) assert.equal(key in snapshot, false, `${key} is not copied`)
    await ctx.db.address.update({ where: { id: saved.id }, data: { line1: "2 Other Road" } })
    assert.equal(snapshot.line1, "1 Example Road")
  })

  test("an address book entry needs a customer: there is no guest owner column", async () => {
    const columns = await ctx.db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'address'`
    const names = columns.map(c => c.column_name)
    assert.ok(names.includes("user_id"))
    assert.equal(names.includes("guest_session_id"), false)
    const [userId] = await ctx.db.$queryRaw`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'address' AND column_name = 'user_id'`
    assert.equal(userId.is_nullable, "NO")
  })
})
