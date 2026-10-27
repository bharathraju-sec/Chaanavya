// CHV-S12-M04: the contact step (apps/api/src/checkout/contact.ts, PUT /api/cart/contact). A guest
// completes the email and delivery address step without an account: no sign-up, no code, no user
// row. Every field is checked and nothing partial is stored; marketing sign-up is not offered
// (owner decision, 26 October 2026); one guest never sees or changes another's details; a customer's
// email is the account's; the details are cleared when a guest bag is merged at sign-in. Nothing
// here places an order, reserves stock or opens checkout.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward, variantId

const api = (method, path, { jar, body, headers = {}, origin } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp(), ...(origin ? { origin } : {}) })
const add = jar => api("POST", "/lines", { jar, body: { variantId, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })
const contact = (jar, body, options = {}) => api("PUT", "/contact", { jar, body, ...options })

const address = (overrides = {}) => ({ name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: "Near the park", city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560001", ...overrides })
const details = (overrides = {}) => ({ email: " Synthetic.Guest@Example.com ", shippingAddress: address(), ...overrides })

async function guestWithBag() {
  const jar = new Jar()
  assert.equal((await add(jar)).status, 200)
  assert.ok(jar.has("chaanavya_guest"), "a guest session was started by the add")
  return jar
}

const counts = async () => ({
  users: await ctx.db.user.count(),
  accounts: await ctx.db.account.count(),
  verifications: await ctx.db.verification.count(),
  orders: await ctx.db.order.count(),
  reservations: await ctx.db.inventoryReservation.count(),
})

before(async () => {
  ctx = await setup("chaanavya_test_s12_guest_contact")
  forward = ctx.routes.me.GET
  const product = await ctx.db.product.create({
    data: { handle: "fixture-contact", title: "Fixture contact", status: "active", publishedAt: new Date(), variants: { create: [{ sku: "fixture-contact-m", title: "M", optionKey: "size:m", pricePaise: 189900n }] } },
    include: { variants: true },
  })
  variantId = product.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId, onHand: 50, lastCountedAt: new Date() } })
})
after(() => ctx?.teardown())

describe("CHV-S12-M04 a guest completes the contact step without an account", () => {
  test("email and delivery address are saved for the guest's bag; no account, order or reservation is created", async () => {
    const jar = await guestWithBag()
    const before = await counts()
    const saved = await contact(jar, details())
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.response.headers.get("cache-control"), "no-store")
    assert.deepEqual(saved.json.data.shippingAddress, { name: "Synthetic Guest", phone: "+916000000000", line1: "1 Example Road", line2: null, landmark: "Near the park", city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560001", country: "IN" })
    assert.equal(saved.json.data.email, "synthetic.guest@example.com")
    assert.equal(saved.json.data.marketing, "not_offered")
    assert.deepEqual(await counts(), before, "no user, sign-in, order or reservation rows")
    assert.equal(await ctx.db.address.count(), 0, "a guest's address never enters an address book")

    const read = await api("GET", "/contact", { jar })
    assert.equal(read.status, 200)
    assert.deepEqual(read.json.data, saved.json.data)

    const changed = await contact(jar, details({ shippingAddress: address({ line1: "2 Second Road" }) }))
    assert.equal(changed.status, 200)
    assert.equal((await api("GET", "/contact", { jar })).json.data.shippingAddress.line1, "2 Second Road")
    assert.equal(await ctx.db.cartContact.count({ where: { email: "synthetic.guest@example.com" } }), 1, "a change updates the one row for this bag")
  })

  test("missing or invalid fields are all named and nothing is stored", async () => {
    const jar = await guestWithBag()
    const refused = await contact(jar, { email: "not-an-email", shippingAddress: address({ district: "", pinCode: "012345", phone: "12345" }) })
    assert.equal(refused.status, 400)
    assert.deepEqual(refused.json.error.fields, { email: "invalid", "shippingAddress.phone": "invalid", "shippingAddress.district": "required", "shippingAddress.pinCode": "invalid" })
    assert.deepEqual((await contact(jar, { shippingAddress: address() })).json.error.fields, { email: "required" })
    assert.deepEqual((await contact(jar, { email: "a@example.com" })).json.error.fields, { shippingAddress: "invalid" })
    assert.deepEqual((await contact(jar, { email: `${"a".repeat(250)}@example.com`, shippingAddress: address() })).json.error.fields, { email: "invalid" })
    assert.equal((await api("GET", "/contact", { jar })).json.data, null)
  })

  test("marketing sign-up is not offered: a yes is refused and nothing is stored; no or absent is fine", async () => {
    const jar = await guestWithBag()
    for (const marketingConsent of [true, "yes", 1]) {
      const refused = await contact(jar, details({ marketingConsent }))
      assert.equal(refused.status, 400, String(marketingConsent))
      assert.deepEqual(refused.json.error.fields, { marketingConsent: "not_offered" })
    }
    assert.equal((await api("GET", "/contact", { jar })).json.data, null)
    assert.equal((await contact(jar, details({ marketingConsent: false }))).status, 200)
  })

  test("without a bag there is nothing to attach details to: 404, and no guest session is started", async () => {
    const jar = new Jar()
    const sessions = await ctx.db.guestSession.count()
    assert.equal((await contact(jar, details())).status, 404)
    assert.equal((await api("GET", "/contact", { jar })).json.data, null)
    assert.equal(await ctx.db.guestSession.count(), sessions)
    assert.equal(jar.has("chaanavya_guest"), false)
    const forged = new Jar({ chaanavya_guest: "A".repeat(43) })
    assert.equal((await contact(forged, details())).status, 404, "a made-up guest token finds no bag")
  })

  test("an emptied bag cannot take contact details", async () => {
    const jar = await guestWithBag()
    assert.equal((await api("DELETE", "", { jar })).status, 200)
    assert.equal((await contact(jar, details())).status, 409)
  })

  test("another site is refused", async () => {
    const jar = await guestWithBag()
    assert.equal((await contact(jar, details(), { origin: "https://evil.example" })).status, 403)
    assert.equal((await api("GET", "/contact", { jar })).json.data, null)
  })
})

describe("CHV-S12-M04 isolation", () => {
  test("one guest never sees or changes another guest's details", async () => {
    const one = await guestWithBag()
    const two = await guestWithBag()
    await contact(one, details({ email: "first.guest@example.com" }))
    assert.equal((await api("GET", "/contact", { jar: two })).json.data, null)
    await contact(two, details({ email: "second.guest@example.com", shippingAddress: address({ line1: "9 Other Road" }) }))
    const first = (await api("GET", "/contact", { jar: one })).json.data
    assert.equal(first.email, "first.guest@example.com")
    assert.equal(first.shippingAddress.line1, "1 Example Road")
  })

  test("the database refuses malformed details written directly", async () => {
    const cart = await ctx.db.cart.findFirstOrThrow({ where: { contact: null } })
    const good = { cartId: cart.id, email: "ok@example.com", shippingAddress: { name: "A", phone: "+916000000000", line1: "1", city: "B", district: "C", stateCode: "IN-KA", pinCode: "560001", country: "IN" } }
    for (const bad of [{ email: "Upper@Example.com" }, { email: "no-at-sign" }, { shippingAddress: { ...good.shippingAddress, pinCode: "012345" } }, { shippingAddress: { ...good.shippingAddress, phone: "6000000000" } }, { shippingAddress: { name: "A" } }, { shippingAddress: [] }]) {
      await assert.rejects(ctx.db.cartContact.create({ data: { ...good, ...bad } }), JSON.stringify(bad))
    }
  })
})

describe("CHV-S12-M04 customers and sign-in", () => {
  test("a customer's order email is the account email; a different one is refused", async () => {
    const jar = await signInCustomer(ctx, "synthetic.buyer@example.com")
    assert.equal((await add(jar)).status, 200)
    const own = await contact(jar, { shippingAddress: address() })
    assert.equal(own.status, 200, JSON.stringify(own.json))
    assert.equal(own.json.data.email, "synthetic.buyer@example.com")
    assert.equal((await contact(jar, { email: "SYNTHETIC.BUYER@example.com", shippingAddress: address() })).status, 200)
    const other = await contact(jar, { email: "someone.else@example.com", shippingAddress: address() })
    assert.equal(other.status, 400)
    assert.deepEqual(other.json.error.fields, { email: "account_email" })
  })

  test("signing in merges the guest bag and clears the guest's contact details", async () => {
    const jar = await guestWithBag()
    await contact(jar, details({ email: "merging.guest@example.com" }))
    const guestCart = await ctx.db.cartContact.findFirstOrThrow({ where: { email: "merging.guest@example.com" } })
    await signInCustomer(ctx, "synthetic.merger@example.com", { jar })
    assert.equal(await ctx.db.cartContact.count({ where: { cartId: guestCart.cartId } }), 0, "the guest details are gone")
    assert.equal((await api("GET", "/contact", { jar })).json.data, null, "the account bag starts without contact details")
  })
})
