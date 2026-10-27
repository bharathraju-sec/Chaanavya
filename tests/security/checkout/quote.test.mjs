// CHV-S12-M09: the checkout quote (apps/api/src/checkout/quote.ts, POST /api/cart/quote). The bag is
// priced on the server from the live catalogue, the applied promotion, the courier's own offer and
// the tax profile; a price, discount, fee, tax or total sent by the browser never changes the quote.
// GST on the delivery fee is shared across lines by value (owner decision, 27 October 2026). A
// quote is refused for a stale, short-stocked or unavailable bag, and only the latest per bag is
// kept. Delivery here is the sandbox courier or a fake; tax values are synthetic test values.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, quotes, compute
const v = {}
const DAY = 86_400_000

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const add = (jar, variantId, quantity = 1) => api("POST", "/lines", { jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() } })
const address = (pinCode = "560034", stateCode = "IN-KA") => ({ name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Example City", district: "Example District", stateCode, pinCode })
const quote = (jar, body = {}) => api("POST", "/quote", { jar, body })

async function bag(items, { pinCode = "560034", stateCode = "IN-KA", contact = true } = {}) {
  const jar = new Jar()
  for (const [key, quantity] of items) assert.equal((await add(jar, v[key], quantity)).status, 200)
  if (contact) assert.equal((await api("PUT", "/contact", { jar, body: { email: "guest@example.com", shippingAddress: address(pinCode, stateCode) } })).status, 200)
  return jar
}

async function fixture(key, { pricePaise, taxCategory = "apparel_cotton", weightGrams = 400, onHand = 20 }) {
  const product = await ctx.db.product.create({
    data: { handle: `fixture-${key}`, title: `Fixture ${key}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-${key}-m`, title: "M", optionKey: "size:m", pricePaise, taxCategory, weightGrams }] } },
    include: { variants: true },
  })
  v[key] = product.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId: v[key], onHand, lastCountedAt: new Date() } })
}

/** Everything in a quote except what changes on every request. */
const priced = q => Object.fromEntries(Object.entries(q).filter(([key]) => key !== "id" && key !== "expiresAt"))
const amount = m => m.amountPaise
const components = taxLines => taxLines.map(t => [t.component, t.rateBasisPoints, t.amount.amountPaise])

before(async () => {
  ctx = await setup("chaanavya_test_s12_quote")
  forward = ctx.routes.me.GET
  quotes = await apiModule("checkout/quote")
  compute = await apiModule("tax/compute")
  const { user } = await createStaff(ctx, "s12.quote.owner@example.com", "OWNER")
  // A draft profile with synthetic rates: usable for test quotes outside production, never live.
  await ctx.db.taxProfile.create({
    data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }, { taxCategory: "apparel_silk", hsnCode: "5007", rateBasisPoints: 1200 }] } },
  })
  await fixture("kurta", { pricePaise: 189900n })
  await fixture("saree", { pricePaise: 520000n, taxCategory: "apparel_silk", weightGrams: 600 })
  await fixture("scarce", { pricePaise: 99900n, onHand: 1 })
  await ctx.db.promotion.create({ data: { code: "TENOFF", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - DAY), active: true } })
})
after(() => ctx?.teardown())

describe("CHV-S12-M09 the server prices the bag", () => {
  test("catalogue price, sandbox delivery and GST (fee included) add up; a test quote says why", async () => {
    const jar = await bag([["kurta", 1]])
    const before = { orders: await ctx.db.order.count(), reservations: await ctx.db.inventoryReservation.count() }
    const res = await quote(jar)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    const q = res.json.data
    assert.deepEqual([amount(q.subtotal), amount(q.discountTotal), amount(q.shippingFee), amount(q.taxTotal), amount(q.grandTotal)], [189900, 0, 3000, 9184, 192900])
    assert.deepEqual(components(q.lines[0].tax), [["CGST", 250, 4521], ["SGST", 250, 4521]], "5% inside 1,899.00")
    assert.deepEqual(components(q.shipping.tax), [["CGST", 250, 71], ["SGST", 250, 71]], "5% inside the 30.00 fee")
    assert.deepEqual([q.shipping.serviceRef, amount(q.shipping.total)], ["sandbox:surface", 3000], "the cheapest offer by default; prices include GST, so the fee does too")
    assert.equal(q.supply, "intra")
    assert.equal(q.mode, "test")
    assert.deepEqual(q.testReasons, ["test_shipping_rates", "tax_profile_unapproved"])
    assert.equal(q.lines[0].classification.profileApproved, false)
    assert.ok(!("owner" in q), "the quote never names the shopper")
    const row = await ctx.db.checkoutQuote.findUnique({ where: { cartId: q.cartId } })
    assert.deepEqual([row.id, Number(row.grandTotalPaise), row.test], [q.id, 192900, true])
    assert.ok(row.expiresAt - row.createdAt === 15 * 60_000)
    assert.deepEqual({ orders: await ctx.db.order.count(), reservations: await ctx.db.inventoryReservation.count() }, before, "no order or reservation")
  })

  test("delivery outside the seller's state is IGST on goods and fee; the shopper may pick another offer", async () => {
    const q = (await quote(await bag([["kurta", 1]], { pinCode: "400001", stateCode: "IN-MH" }), { serviceRef: "sandbox:air" })).json.data
    assert.equal(q.supply, "inter")
    assert.deepEqual(components(q.lines[0].tax), [["IGST", 500, 9043]])
    assert.deepEqual([q.shipping.serviceRef, amount(q.shippingFee)], ["sandbox:air", 9000], "national air")
    assert.deepEqual(components(q.shipping.tax), [["IGST", 500, 429]])
    assert.equal(amount(q.grandTotal), 189900 + 9000)
  })

  test("the applied promotion is checked again and its discount comes from the server", async () => {
    const jar = await bag([["kurta", 1]])
    assert.equal((await api("POST", "/promotion", { jar, body: { code: "TENOFF" } })).status, 200)
    const q = (await quote(jar)).json.data
    assert.deepEqual([amount(q.discountTotal), amount(q.grandTotal)], [18990, 189900 - 18990 + 3000])
    assert.ok(q.promotionId)
  })

  test("the price is the catalogue's now: a price change shows in the next quote", async () => {
    const jar = await bag([["saree", 1]])
    const first = (await quote(jar)).json.data
    await ctx.db.productVariant.update({ where: { id: v.saree }, data: { pricePaise: 480000n } })
    const second = (await quote(jar)).json.data
    await ctx.db.productVariant.update({ where: { id: v.saree }, data: { pricePaise: 520000n } })
    assert.deepEqual([amount(first.subtotal), amount(second.subtotal)], [520000, 480000])
  })
})

describe("CHV-S12-M09 tampered input never changes the quote", () => {
  test("prices, discounts, fees, taxes and totals in the body, the query or headers are ignored", async () => {
    const jar = await bag([["kurta", 2], ["saree", 1]])
    const honest = (await quote(jar)).json.data
    const tampered = {
      grandTotal: { amountPaise: 1, currency: "INR" },
      subtotal: { amountPaise: 1, currency: "INR" },
      discountTotal: { amountPaise: 999999, currency: "INR" },
      shippingFee: { amountPaise: 0, currency: "INR" },
      taxTotal: { amountPaise: 0, currency: "INR" },
      expectedGrandTotal: { amountPaise: 1, currency: "INR" },
      lines: [{ variantId: v.kurta, quantity: 2, unitPrice: { amountPaise: 1, currency: "INR" } }],
      unitPricePaise: 1,
      price: 1,
      pricesIncludeTax: false,
      promotionCode: "FREE100",
      discountPaise: 999999,
      shipping: { fee: { amountPaise: 0, currency: "INR" }, serviceRef: "sandbox:surface" },
      mode: "live",
      currency: "USD",
    }
    const res = await call(forward, "/api/cart/quote?grandTotal=1&price=1&shippingFee=0", { method: "POST", jar, body: tampered, headers: { "x-price": "1", "x-grand-total": "1" }, ip: newIp() })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(priced(res.json.data), priced(honest), "the tampered request is priced exactly like the honest one")
    assert.equal(amount(res.json.data.grandTotal), 189900 * 2 + 520000 + 7000, "1.4 kg is three surface slabs")
    const stored = await ctx.db.checkoutQuote.findUnique({ where: { cartId: honest.cartId } })
    assert.equal(Number(stored.grandTotalPaise), amount(honest.grandTotal))
  })

  test("a delivery option the courier did not offer is refused, never priced", async () => {
    const jar = await bag([["kurta", 1]])
    for (const serviceRef of ["free-shipping", "sandbox:drone", "live-surface-1"]) {
      const res = await quote(jar, { serviceRef })
      assert.equal(res.status, 400, serviceRef)
      assert.deepEqual(res.json.error.fields, { serviceRef: "not_offered" })
    }
    for (const serviceRef of [42, "", { amountPaise: 0 }]) assert.equal((await quote(jar, { serviceRef })).status, 400)
  })

  test("a stale bag revision is refused, and a quote is stored only for the bag it priced", async () => {
    const jar = await bag([["kurta", 1]])
    const current = (await api("GET", "", { jar })).json.data
    assert.equal((await quote(jar, { cartRevision: current.revision })).status, 200)
    const stale = await quote(jar, { cartRevision: current.revision - 1 })
    assert.equal(stale.status, 409)
    assert.deepEqual(stale.json.error.fields, { cartRevision: "stale" })
    assert.equal((await quote(jar, { cartRevision: -1 })).status, 400)
  })

  test("only the latest quote is kept; parallel quotes leave exactly one row, one of theirs", async () => {
    const jar = await bag([["kurta", 1]])
    const results = await Promise.all(Array.from({ length: 6 }, () => quote(jar)))
    assert.ok(results.every(r => r.status === 200 || r.status === 409), results.map(r => r.status).join())
    const ids = results.filter(r => r.status === 200).map(r => r.json.data.id)
    assert.ok(ids.length >= 1)
    const rows = await ctx.db.checkoutQuote.findMany({ where: { cartId: results.find(r => r.status === 200).json.data.cartId } })
    assert.equal(rows.length, 1)
    assert.ok(ids.includes(rows[0].id))
    const again = (await quote(jar)).json.data
    assert.equal((await ctx.db.checkoutQuote.findUnique({ where: { cartId: again.cartId } })).id, again.id, "a new quote replaces the old")
  })
})

describe("CHV-S12-M09 a bag that cannot be sold as it is gets no quote", () => {
  test("no bag, no address, empty bag, short or uncounted stock, a withdrawn item", async () => {
    assert.equal((await quote(new Jar())).status, 404)
    const noAddress = await quote(await bag([["kurta", 1]], { contact: false }))
    assert.deepEqual([noAddress.status, noAddress.json.error.fields], [409, { shippingAddress: "required" }])

    // Stock taken by someone else after the item was added: the quote checks again.
    const shortBag = await bag([["scarce", 1]])
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce }, data: { reserved: 1 } })
    const short = await quote(shortBag)
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce }, data: { reserved: 0 } })
    assert.equal(short.status, 409)
    assert.deepEqual(Object.values(short.json.error.fields), ["insufficient_stock"])

    const uncounted = await bag([["scarce", 1]])
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce }, data: { lastCountedAt: null } })
    const refusedUncounted = await quote(uncounted)
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce }, data: { lastCountedAt: new Date() } })
    // An uncounted item leaves the public catalogue, so the bag already flags it unavailable.
    assert.deepEqual([refusedUncounted.status, Object.values(refusedUncounted.json.error.fields)], [409, ["unavailable"]])

    const withdrawn = await bag([["scarce", 1]])
    await ctx.db.productVariant.update({ where: { id: v.scarce }, data: { archivedAt: new Date() } })
    const refusedWithdrawn = await quote(withdrawn)
    await ctx.db.productVariant.update({ where: { id: v.scarce }, data: { archivedAt: null } })
    assert.deepEqual([refusedWithdrawn.status, Object.values(refusedWithdrawn.json.error.fields)], [409, ["unavailable"]])

    const emptied = await bag([["kurta", 1]])
    assert.equal((await api("DELETE", "", { jar: emptied })).status, 200)
    assert.equal((await quote(emptied)).status, 409)
  })

  test("production has no courier and never uses a draft tax profile", async () => {
    const jar = await bag([["kurta", 1]])
    const cart = await ctx.db.cart.findFirst({ where: { contact: { isNot: null } }, orderBy: { createdAt: "desc" } })
    const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
    assert.ok(jar.has("chaanavya_guest"))
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { env: { APP_ENV: "production" } }), e => e.status === 409 && e.fields.shipping === "no_courier")
    const live = {
      gateway: {
        provider: "shiprocket",
        mode: "live",
        checkServiceability: async () => ({ serviceable: true, codAvailable: false, reason: "ok" }),
        quoteRates: async () => ({ status: "available", options: [{ serviceRef: "live-1", courierName: "Synthetic Live", rate: { amountPaise: 7000, currency: "INR" }, estimatedDeliveryDays: 3, quotedAt: new Date().toISOString(), mode: "surface", maxWeightGrams: 10000, maxDeclaredValuePaise: null, acceptsRestrictions: [] }], quotedAt: new Date().toISOString() }),
      },
      pickupPinCode: "560001",
    }
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { env: { APP_ENV: "production" }, courier: live }), e => e.status === 409 && e.fields.tax === "no_active_profile")
    const dev = await quotes.quoteBag(ctx.db, owner, {}, { env: { APP_ENV: "development" }, courier: live })
    assert.deepEqual([dev.mode, dev.testReasons, amount(dev.shippingFee)], ["test", ["tax_profile_unapproved"], 7000])
  })
})

describe("CHV-S12-M09 GST on the delivery fee is shared by value", () => {
  const profile = (pricesIncludeTax = true) => ({ id: "p", approved: true, sellerStateCode: "IN-KA", pricesIncludeTax, rates: [{ taxCategory: "a", hsnCode: "6204", rateBasisPoints: 500 }, { taxCategory: "b", hsnCode: "5007", rateBasisPoints: 1200 }] })
  const lines = [
    { key: "low", taxCategory: "a", unitPricePaise: 100000n, quantity: 1 },
    { key: "high", taxCategory: "b", unitPricePaise: 300000n, quantity: 1 },
  ]

  test("the fee is split by line value after discount and each share is taxed at its line's rate", () => {
    const r = compute.computeTax({ lines, discountPaise: 0n, profile: profile(false), deliveryStateCode: "IN-MH", shippingFeePaise: 10001n })
    assert.deepEqual(r.shipping.shares.map(s => [s.key, s.sharePaise]), [["low", 2500n], ["high", 7501n]], "one left-over paisa to the larger remainder")
    assert.deepEqual(r.shipping.shares.map(s => s.tax.map(c => [c.component, c.rateBasisPoints, c.amountPaise])), [[["IGST", 500, 125n]], [["IGST", 1200, 900n]]])
    assert.deepEqual([r.shipping.feePaise, r.shipping.taxPaise, r.shipping.totalPaise], [10001n, 1025n, 11026n], "prices exclude GST: the fee's GST is added")
    assert.deepEqual(r.shipping.tax.map(c => [c.component, c.rateBasisPoints, c.amountPaise]), [["IGST", 500, 125n], ["IGST", 1200, 900n]])
  })

  test("with GST-inclusive prices the fee includes its GST; a fee larger than the goods still splits", () => {
    const r = compute.computeTax({ lines, discountPaise: 0n, profile: profile(true), deliveryStateCode: "IN-KA", shippingFeePaise: 900000n })
    assert.equal(r.shipping.totalPaise, 900000n)
    assert.equal(r.shipping.shares.reduce((a, s) => a + s.sharePaise, 0n), 900000n)
    assert.equal(r.shipping.taxablePaise + r.shipping.taxPaise, 900000n)
  })

  test("a fully discounted bag shares the fee by list price; a zero fee adds nothing; a negative fee is refused", () => {
    const free = compute.computeTax({ lines, discountPaise: 400000n, profile: profile(), deliveryStateCode: "IN-KA", shippingFeePaise: 4000n })
    assert.deepEqual(free.shipping.shares.map(s => s.sharePaise), [1000n, 3000n])
    const none = compute.computeTax({ lines, discountPaise: 0n, profile: profile(), deliveryStateCode: "IN-KA" })
    assert.deepEqual([none.shipping.feePaise, none.shipping.taxPaise, none.shipping.tax], [0n, 0n, []])
    assert.throws(() => compute.computeTax({ lines, discountPaise: 0n, profile: profile(), deliveryStateCode: "IN-KA", shippingFeePaise: -1n }), e => e.status === 409)
  })
})
