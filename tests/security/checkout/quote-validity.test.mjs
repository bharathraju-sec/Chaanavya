// CHV-S12-M10: quote expiry and fingerprint (apps/api/src/checkout/quote-fingerprint.ts, checkQuote in
// apps/api/src/checkout/quote.ts, GET /api/cart/quote/:quoteId). A stored quote is valid only for its
// owner, its bag and the inputs it was priced from, and only for 15 minutes. Once it expires, or the
// bag, a price, the promotion, the address, the delivery rate, the tax or the stock changes, it is
// refused with what changed and discarded, so it can never become valid again. Delivery is the
// sandbox courier; tax values are synthetic test values.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward, quotes, fingerprint, profileId
const DAY = 86_400_000
const MINUTE = 60_000

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const add = (jar, variantId, quantity = 1) => api("POST", "/lines", { jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() } })
const address = (pinCode = "560034", stateCode = "IN-KA") => ({ name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Example City", district: "Example District", stateCode, pinCode })
const contact = (jar, pinCode, stateCode) => api("PUT", "/contact", { jar, body: { email: "guest@example.com", shippingAddress: address(pinCode, stateCode) } })
const check = (jar, id) => api("GET", `/quote/${id}`, { jar })

let n = 0
/** A fresh product per test, so changing one never touches another test's bag. */
async function product({ pricePaise = 189900n, weightGrams = 400, onHand = 20 } = {}) {
  n += 1
  const created = await ctx.db.product.create({
    data: { handle: `fixture-validity-${n}`, title: `Fixture ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-validity-${n}-m`, title: "M", optionKey: "size:m", pricePaise, taxCategory: "apparel_cotton", weightGrams }] } },
    include: { variants: true },
  })
  const variantId = created.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId, onHand, lastCountedAt: new Date() } })
  return { productId: created.id, variantId }
}

/** A guest with a bag of one fresh product, a delivery address and a stored quote. */
async function quoted(options = {}) {
  const item = await product(options)
  const jar = new Jar()
  assert.equal((await add(jar, item.variantId)).status, 200)
  assert.equal((await contact(jar)).status, 200)
  const res = await api("POST", "/quote", { jar, body: {} })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return { jar, item, quote: res.json.data }
}

/** Expects a refused check naming exactly these changed parts; the quote is then gone. */
async function refusedFor(jar, id, parts) {
  const res = await check(jar, id)
  assert.equal(res.status, 409, JSON.stringify(res.json))
  const { quote: reason, ...changed } = res.json.error.fields
  assert.equal(reason, "changed")
  for (const part of parts) assert.equal(changed[part], "changed", `${part} in ${JSON.stringify(changed)}`)
  assert.equal(await ctx.db.checkoutQuote.count({ where: { id } }), 0, "a changed quote is discarded")
  assert.equal((await check(jar, id)).status, 404, "and never comes back")
  return changed
}

const ownerOf = async cartId => {
  const cart = await ctx.db.cart.findUnique({ where: { id: cartId } })
  return { kind: "guest", guestSessionId: cart.guestSessionId }
}

before(async () => {
  ctx = await setup("chaanavya_test_s12_quote_validity")
  forward = ctx.routes.me.GET
  quotes = await apiModule("checkout/quote")
  fingerprint = await apiModule("checkout/quote-fingerprint")
  const { user } = await createStaff(ctx, "s12.validity.owner@example.com", "OWNER")
  const profile = await ctx.db.taxProfile.create({
    data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } },
  })
  profileId = profile.id
  await ctx.db.promotion.create({ data: { code: "VALID10", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - DAY), active: true } })
})
after(() => ctx?.teardown())

describe("CHV-S12-M10 an unchanged quote stays valid until it expires", () => {
  test("a fresh quote checks as valid, any number of times, and checking changes nothing", async () => {
    const { jar, quote } = await quoted()
    const results = await Promise.all([check(jar, quote.id), check(jar, quote.id), check(jar, quote.id)])
    for (const res of results) {
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.response.headers.get("cache-control"), "no-store")
      assert.equal(res.json.data.status, "valid")
      assert.deepEqual(res.json.data.quote, quote)
    }
    const row = await ctx.db.checkoutQuote.findUnique({ where: { id: quote.id } })
    assert.match(row.fingerprint, /^[0-9a-f]{64}$/)
    assert.match(row.ownerHash, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(row, (_, value) => (typeof value === "bigint" ? String(value) : value)).includes((await ctx.db.cart.findUnique({ where: { id: quote.cartId } })).guestSessionId), "the owner id itself is not stored with the quote")
    assert.ok(!("fingerprint" in quote) && !("ownerHash" in quote), "the binding is never sent to the browser")
  })

  test("it expires at 15 minutes exactly: valid a millisecond before, refused at expiry, then discarded", async () => {
    const { quote } = await quoted()
    const owner = await ownerOf(quote.cartId)
    const expires = new Date(quote.expiresAt).getTime()
    assert.equal(expires - (await ctx.db.checkoutQuote.findUnique({ where: { id: quote.id } })).createdAt.getTime(), 15 * MINUTE)
    assert.equal((await quotes.checkQuote(ctx.db, owner, quote.id, { now: new Date(expires - 1) })).status, "valid")
    await assert.rejects(quotes.checkQuote(ctx.db, owner, quote.id, { now: new Date(expires) }), e => e.status === 409 && e.fields.quote === "expired")
    assert.equal(await ctx.db.checkoutQuote.count({ where: { id: quote.id } }), 0)
    await assert.rejects(quotes.checkQuote(ctx.db, owner, quote.id, { now: new Date(expires - 1) }), e => e.status === 404, "an expired quote never becomes valid again, even with the clock turned back")
  })

  test("a title or photo change does not matter: only what is charged is bound", async () => {
    const { jar, item, quote } = await quoted()
    await ctx.db.product.update({ where: { id: item.productId }, data: { title: "Renamed fixture" } })
    assert.equal((await check(jar, quote.id)).status, 200)
  })
})

describe("CHV-S12-M10 a quote is bound to its owner and is the bag's latest", () => {
  test("another shopper, an unknown id or a malformed id gets 404, and the owner's quote is untouched", async () => {
    const { jar, quote } = await quoted()
    const stranger = new Jar()
    assert.equal((await add(stranger, (await product()).variantId)).status, 200)
    assert.equal((await check(stranger, quote.id)).status, 404)
    assert.equal((await check(new Jar(), quote.id)).status, 404, "no session at all")
    assert.equal((await check(jar, randomUUID())).status, 404)
    assert.equal((await check(jar, "not-a-uuid")).status, 404)
    assert.equal((await check(jar, `${quote.id}' OR '1'='1`)).status, 404)
    assert.equal((await check(jar, quote.id)).status, 200, "the owner can still use it")
  })

  test("a newer quote replaces the old one: the old id is 404", async () => {
    const { jar, quote: first } = await quoted()
    const second = (await api("POST", "/quote", { jar, body: { serviceRef: "sandbox:air" } })).json.data
    assert.equal((await check(jar, first.id)).status, 404)
    assert.equal((await check(jar, second.id)).json.data.quote.shipping.serviceRef, "sandbox:air")
  })

  test("signing in makes the shopper a customer: the guest's quote no longer belongs to them", async () => {
    const { jar, quote } = await quoted()
    await signInCustomer(ctx, `s12.validity.${randomUUID().slice(0, 8)}@example.com`, { jar })
    await api("GET", "", { jar })
    assert.equal((await check(jar, quote.id)).status, 404)
  })

  test("a changed fingerprint version is never matched", async () => {
    const { jar, quote } = await quoted()
    await ctx.db.checkoutQuote.update({ where: { id: quote.id }, data: { fingerprintVersion: fingerprint.FINGERPRINT_VERSION + 1 } })
    assert.equal((await check(jar, quote.id)).status, 404)
  })
})

describe("CHV-S12-M10 any change to what the quote was priced from invalidates it", () => {
  test("bag contents: a quantity change or another item", async () => {
    const a = await quoted()
    const lineId = (await api("GET", "", { jar: a.jar })).json.data.lines[0].id
    assert.equal((await api("PATCH", `/lines/${lineId}`, { jar: a.jar, body: { quantity: 2 } })).status, 200)
    await refusedFor(a.jar, a.quote.id, ["cart"])

    const b = await quoted()
    assert.equal((await add(b.jar, (await product()).variantId)).status, 200)
    await refusedFor(b.jar, b.quote.id, ["cart"])
  })

  test("price: the catalogue price changed", async () => {
    const { jar, item, quote } = await quoted()
    await ctx.db.productVariant.update({ where: { id: item.variantId }, data: { pricePaise: 179900n } })
    const changed = await refusedFor(jar, quote.id, ["price", "tax"])
    assert.equal(changed.cart, undefined, "the bag itself did not change")
  })

  test("promotion: the applied code stops applying", async () => {
    const { jar, quote: before } = await quoted()
    assert.equal((await api("POST", "/promotion", { jar, body: { code: "VALID10" } })).status, 200)
    const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
    assert.equal(quote.discountTotal.amountPaise, 18990)
    assert.equal((await check(jar, before.id)).status, 404, "applying the code replaced nothing silently: the earlier quote is gone")
    await ctx.db.promotion.update({ where: { code: "VALID10" }, data: { active: false } })
    await refusedFor(jar, quote.id, ["promotion"])
    await ctx.db.promotion.update({ where: { code: "VALID10" }, data: { active: true } })
  })

  test("address: the delivery address changed", async () => {
    const { jar, quote } = await quoted()
    assert.equal((await contact(jar, "560001", "IN-KA")).status, 200)
    const changed = await refusedFor(jar, quote.id, ["address"])
    assert.equal(changed.price, undefined)
  })

  test("delivery: the courier's rate changed (a heavier parcel)", async () => {
    const { jar, item, quote } = await quoted()
    await ctx.db.productVariant.update({ where: { id: item.variantId }, data: { weightGrams: 1200 } })
    const changed = await refusedFor(jar, quote.id, ["delivery"])
    assert.deepEqual([changed.cart, changed.price], [undefined, undefined], "only the delivery part")
  })

  test("tax: the tax profile's rate changed", async () => {
    const { jar, quote } = await quoted()
    await ctx.db.taxRate.update({ where: { profileId_taxCategory: { profileId, taxCategory: "apparel_cotton" } }, data: { rateBasisPoints: 1200 } })
    try {
      await refusedFor(jar, quote.id, ["tax"])
    } finally {
      await ctx.db.taxRate.update({ where: { profileId_taxCategory: { profileId, taxCategory: "apparel_cotton" } }, data: { rateBasisPoints: 500 } })
    }
  })

  test("tax: the profile no longer has a rate for the bag's category", async () => {
    const { jar, quote } = await quoted()
    const rate = await ctx.db.taxRate.findUniqueOrThrow({ where: { profileId_taxCategory: { profileId, taxCategory: "apparel_cotton" } } })
    await ctx.db.taxRate.delete({ where: { profileId_taxCategory: { profileId, taxCategory: "apparel_cotton" } } })
    try {
      await refusedFor(jar, quote.id, ["tax"])
    } finally {
      await ctx.db.taxRate.create({ data: rate })
    }
  })

  test("stock: units taken by someone else, or the item withdrawn", async () => {
    const short = await quoted({ onHand: 1 })
    await ctx.db.inventoryBalance.update({ where: { variantId: short.item.variantId }, data: { reserved: 1 } })
    await refusedFor(short.jar, short.quote.id, ["stock"])

    const gone = await quoted()
    await ctx.db.productVariant.update({ where: { id: gone.item.variantId }, data: { archivedAt: new Date() } })
    await refusedFor(gone.jar, gone.quote.id, ["stock"])
  })

  test("a refused quote is replaced by asking again, priced from the new inputs", async () => {
    const { jar, item, quote } = await quoted()
    await ctx.db.productVariant.update({ where: { id: item.variantId }, data: { pricePaise: 150000n } })
    await refusedFor(jar, quote.id, ["price"])
    const fresh = (await api("POST", "/quote", { jar, body: {} })).json.data
    assert.equal(fresh.subtotal.amountPaise, 150000)
    assert.equal((await check(jar, fresh.id)).status, 200)
  })
})

describe("CHV-S12-M10 the fingerprint covers every part and the owner", () => {
  test("each part changes the fingerprint; the owner changes it too", async () => {
    const { quote } = await quoted()
    const owner = await ownerOf(quote.cartId)
    const at = { pinCode: "560034", stateCode: "IN-KA" }
    const base = fingerprint.fingerprintOf(owner, quote, at)
    assert.deepEqual(fingerprint.fingerprintOf(owner, structuredClone(quote), { ...at }), base, "same inputs, same fingerprint")
    const variants = {
      cart: { ...quote, cartRevision: quote.cartRevision + 1 },
      price: { ...quote, lines: quote.lines.map(l => ({ ...l, unitPrice: { ...l.unitPrice, amountPaise: l.unitPrice.amountPaise + 1 } })) },
      promotion: { ...quote, discountTotal: { ...quote.discountTotal, amountPaise: 1 } },
      delivery: { ...quote, shipping: { ...quote.shipping, fee: { ...quote.shipping.fee, amountPaise: quote.shipping.fee.amountPaise + 1 } } },
      tax: { ...quote, lines: quote.lines.map(l => ({ ...l, classification: { ...l.classification, rateBasisPoints: 1200 } })) },
    }
    for (const [part, changed] of Object.entries(variants)) {
      const print = fingerprint.fingerprintOf(owner, changed, at)
      assert.notEqual(print.fingerprint, base.fingerprint, part)
      assert.notEqual(print.parts[part], base.parts[part], part)
    }
    assert.notEqual(fingerprint.fingerprintOf(owner, quote, { ...at, pinCode: "560001" }).parts.address, base.parts.address)
    assert.notEqual(fingerprint.fingerprintOf({ kind: "guest", guestSessionId: randomUUID() }, quote, at).fingerprint, base.fingerprint, "another owner")
    assert.notEqual(fingerprint.fingerprintOf(owner, { ...quote, testReasons: ["tax_profile_unapproved"] }, at).parts.delivery, base.parts.delivery, "test or live rates is part of the rate version")
    assert.notEqual(fingerprint.fingerprintOf(owner, { ...quote, grandTotal: { ...quote.grandTotal, amountPaise: 1 } }, at).fingerprint, base.fingerprint, "the grand total is bound as well")
  })
})
