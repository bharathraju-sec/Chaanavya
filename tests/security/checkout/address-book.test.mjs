// CHV-S12-M03: saved-address API (apps/api/src/modules/address.controller.ts,
// apps/api/src/checkout/address-book.ts). Customer A cannot read, edit, delete or make default
// customer B's address: each attempt gets the same 404 as a made-up id and B's address is left
// exactly as it was. Also: sign-in and a verified email are required, every address is checked,
// there is one default, and parallel requests keep it that way.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward, alice, bob

const api = (method, path, { jar, body, origin } = {}) => call(forward, `/api/account/addresses${path}`, { method, jar, body, ip: newIp(), ...(origin ? { origin } : {}) })

const home = (overrides = {}) => ({ name: "Synthetic Customer", phone: "6000000000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560001", ...overrides })

async function save(jar, address = home(), extra = {}) {
  const response = await api("POST", "", { jar, body: { address, ...extra } })
  assert.equal(response.status, 201, JSON.stringify(response.json))
  return response.json.data
}

const rowOf = id => ctx.db.address.findUnique({ where: { id } })
const userOf = email => ctx.db.user.findUniqueOrThrow({ where: { email } })
const defaults = async email => ctx.db.address.count({ where: { userId: (await userOf(email)).id, isDefault: true } })

before(async () => {
  ctx = await setup("chaanavya_test_s12_address_book")
  forward = ctx.routes.me.GET
  alice = await signInCustomer(ctx, "synthetic.alice@example.com")
  bob = await signInCustomer(ctx, "synthetic.bob@example.com")
})
after(() => ctx?.teardown())

describe("CHV-S12-M03 ownership", () => {
  test("customer A cannot see, edit, delete or make default customer B's address", async () => {
    const bobs = await save(bob, home({ name: "Synthetic Bob", line1: "9 Other Road" }))
    const before = await rowOf(bobs.id)
    const madeUp = await api("PATCH", `/${randomUUID()}`, { jar: alice, body: { address: { line1: "x" } } })
    assert.equal(madeUp.status, 404)

    const list = await api("GET", "", { jar: alice })
    assert.equal(list.status, 200)
    assert.equal(list.json.data.some(a => a.id === bobs.id), false, "B's address is not in A's list")

    const attempts = [
      await api("PATCH", `/${bobs.id}`, { jar: alice, body: { address: { line1: "Taken Over Road", phone: "6111111111" } } }),
      await api("POST", `/${bobs.id}/default`, { jar: alice }),
      await api("DELETE", `/${bobs.id}`, { jar: alice }),
    ]
    for (const attempt of attempts) {
      assert.equal(attempt.status, 404)
      assert.deepEqual(attempt.json, madeUp.json, "the same answer as a made-up id")
    }
    assert.deepEqual(await rowOf(bobs.id), before, "B's address is unchanged")
    assert.equal((await api("GET", "", { jar: bob })).json.data.find(a => a.id === bobs.id).address.line1, "9 Other Road")
  })

  test("A's edits to its own address never touch B's", async () => {
    const mine = await save(alice)
    const bobs = await save(bob)
    const before = await rowOf(bobs.id)
    const edited = await api("PATCH", `/${mine.id}`, { jar: alice, body: { address: { line1: "2 New Road" } } })
    assert.equal(edited.status, 200)
    assert.equal(edited.json.data.address.line1, "2 New Road")
    assert.deepEqual(await rowOf(bobs.id), before)
  })

  test("signed out is 401, an unverified email is 403, another site is refused, malformed ids are 404", async () => {
    assert.equal((await api("GET", "")).status, 401)
    assert.equal((await api("POST", "", { body: { address: home() } })).status, 401)
    const eve = await signInCustomer(ctx, "synthetic.eve@example.com")
    await ctx.db.user.update({ where: { email: "synthetic.eve@example.com" }, data: { emailVerified: false } })
    const refused = await api("POST", "", { jar: eve, body: { address: home() } })
    assert.equal(refused.status, 403)
    assert.equal(await ctx.db.address.count({ where: { userId: (await userOf("synthetic.eve@example.com")).id } }), 0)
    const crossSite = await api("POST", "", { jar: alice, body: { address: home() }, origin: "https://evil.example" })
    assert.equal(crossSite.status, 403)
    for (const id of ["not-a-uuid", "1", "%00", "' OR 1=1 --"]) assert.equal((await api("PATCH", `/${encodeURIComponent(id)}`, { jar: alice, body: { address: { line1: "x" } } })).status, 404, id)
  })
})

describe("CHV-S12-M03 create, edit, delete, default", () => {
  test("an invalid address is refused with its fields named and nothing is saved", async () => {
    const carol = await signInCustomer(ctx, "synthetic.carol@example.com")
    const refused = await api("POST", "", { jar: carol, body: { address: home({ pinCode: "012345", district: "", stateCode: "IN-ZZ" }) } })
    assert.equal(refused.status, 400)
    assert.deepEqual(refused.json.error.fields, { district: "required", stateCode: "invalid", pinCode: "invalid" })
    assert.equal((await api("POST", "", { jar: carol, body: home() })).status, 400, "the address must be sent as { address }")
    assert.equal((await api("GET", "", { jar: carol })).json.data.length, 0)
  })

  test("an edit is checked as a whole; a bad edit changes nothing", async () => {
    const mine = await save(alice)
    const before = await rowOf(mine.id)
    const bad = await api("PATCH", `/${mine.id}`, { jar: alice, body: { address: { pinCode: "99999", phone: "123" } } })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.json.error.fields, { phone: "invalid", pinCode: "invalid" })
    assert.deepEqual(await rowOf(mine.id), before)
    const good = await api("PATCH", `/${mine.id}`, { jar: alice, body: { address: { pinCode: "570001", city: "Mysuru", district: "Mysuru" } } })
    assert.equal(good.status, 200)
    assert.equal(good.json.data.address.pinCode, "570001")
    assert.equal(good.json.data.address.line1, before.line1, "fields not sent are kept")
    assert.equal((await api("PATCH", `/${mine.id}`, { jar: alice, body: { address: { district: null } } })).status, 400, "a mandatory field cannot be cleared")
  })

  test("the first address is the default, one default at a time, and deleting the default promotes the newest", async () => {
    const dave = await signInCustomer(ctx, "synthetic.dave@example.com")
    const first = await save(dave)
    assert.equal(first.isDefault, true)
    const second = await save(dave, home({ line1: "2 Second Road" }))
    assert.equal(second.isDefault, false)
    const third = await save(dave, home({ line1: "3 Third Road" }), { isDefault: true })
    assert.equal(third.isDefault, true)
    assert.equal(await defaults("synthetic.dave@example.com"), 1)

    const chosen = await api("POST", `/${second.id}/default`, { jar: dave })
    assert.equal(chosen.status, 200)
    assert.equal(chosen.json.data.isDefault, true)
    assert.equal(await defaults("synthetic.dave@example.com"), 1)
    assert.equal((await api("GET", "", { jar: dave })).json.data[0].id, second.id, "the default is listed first")

    assert.equal((await api("DELETE", `/${second.id}`, { jar: dave })).status, 204)
    assert.equal(await rowOf(second.id), null)
    assert.equal((await api("DELETE", `/${second.id}`, { jar: dave })).status, 404, "a second delete finds nothing")
    const left = (await api("GET", "", { jar: dave })).json.data
    assert.deepEqual(left.map(a => a.id).sort(), [first.id, third.id].sort())
    assert.equal(left.filter(a => a.isDefault).length, 1, "the newest remaining address became the default")
  })

  test("the database allows only one default per customer", async () => {
    const user = await userOf("synthetic.dave@example.com")
    const row = { userId: user.id, name: "Synthetic", phone: "+916000000000", line1: "1 Example Road", city: "Mysuru", district: "Mysuru", stateCode: "IN-KA", pinCode: "570001", isDefault: true }
    await assert.rejects(ctx.db.address.create({ data: row }))
  })

  test("an address book holds up to 20 addresses", async () => {
    const erin = await signInCustomer(ctx, "synthetic.erin@example.com")
    for (let i = 0; i < 20; i++) await save(erin, home({ line1: `${i + 1} Example Road` }))
    const over = await api("POST", "", { jar: erin, body: { address: home() } })
    assert.equal(over.status, 409)
    assert.equal(await ctx.db.address.count({ where: { userId: (await userOf("synthetic.erin@example.com")).id } }), 20)
  })
})

describe("CHV-S12-M03 parallel requests", () => {
  test("parallel first saves and default changes leave exactly one default", async () => {
    const frank = await signInCustomer(ctx, "synthetic.frank@example.com")
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) => api("POST", "", { jar: frank, body: { address: home({ line1: `${i + 1} Race Road` }), isDefault: i % 2 === 0 } })))
    assert.deepEqual(created.map(r => r.status), Array(6).fill(201))
    assert.equal(await defaults("synthetic.frank@example.com"), 1)
    const ids = created.map(r => r.json.data.id)
    const flips = await Promise.all(ids.map(id => api("POST", `/${id}/default`, { jar: frank })))
    assert.deepEqual(flips.map(r => r.status), Array(6).fill(200))
    assert.equal(await defaults("synthetic.frank@example.com"), 1)
  })

  test("B racing A's own edits and deletes cannot change A's address", async () => {
    const mine = await save(alice, home({ line1: "7 Race Road" }))
    const results = await Promise.all([
      api("PATCH", `/${mine.id}`, { jar: bob, body: { address: { line1: "Hijack Road" } } }),
      api("DELETE", `/${mine.id}`, { jar: bob }),
      api("PATCH", `/${mine.id}`, { jar: alice, body: { address: { line1: "8 Race Road" } } }),
      api("POST", `/${mine.id}/default`, { jar: bob }),
    ])
    assert.deepEqual(results.map(r => r.status), [404, 404, 200, 404])
    assert.equal((await rowOf(mine.id)).line1, "8 Race Road")
  })
})
