// CHV-S13-M01: order identifiers and immutable snapshots (apps/api/src/orders/snapshot.ts, migration
// 20261028000000_order_snapshots). An order placed from a checked quote carries everything it was sold
// on (customer, every line with its tax classification, the tax basis, the delivery option and its
// GST, the totals, the address and the quote's fingerprint), copied from the quote without re-pricing.
// Later catalogue, price, tax, courier, promotion or address edits never change it, and the database
// refuses any direct edit of what was sold; only status, fulfilment status and account links move.
// The quote comes from the real API through the web host's forwarder; tax values are synthetic test
// values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"

let ctx, forward, snapshots, profileId
let n = 0

const api = (method, path, { jar, body } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers: path === "/lines" ? { "idempotency-key": randomUUID() } : {}, ip: newIp() })
const address = (pinCode = "560034", stateCode = "IN-KA") => ({ name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: "Near the park", city: "Bengaluru", district: "Bengaluru Urban", stateCode, pinCode })

/** A product the shop sells, with a photo, a weight, a tax category and counted stock. */
async function product({ price = 189900n, weightGrams = 400 } = {}) {
  n += 1
  const p = await ctx.db.product.create({
    data: {
      handle: `fixture-order-${n}`,
      title: `Fixture order ${n}`,
      status: "active",
      publishedAt: new Date(),
      shippingRestriction: "none",
      variants: { create: [{ sku: `fixture-order-${n}-m`, title: "M", optionKey: "size:m", pricePaise: price, taxCategory: "apparel_cotton", weightGrams }] },
      media: { create: [{ url: `https://media.example.test/fixture-order-${n}.jpg`, status: "approved", position: 0 }] },
    },
    include: { variants: true, media: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 20, lastCountedAt: new Date() } })
  return { product: p, variant: p.variants[0] }
}

/** A guest bag, its contact step and a checked quote, then the order placed from them. */
async function placed({ items = 1, code } = {}) {
  const made = []
  for (let i = 0; i < items; i++) made.push(await product({ price: BigInt(189900 + i * 100001) }))
  const jar = new Jar()
  for (const m of made) assert.equal((await api("POST", "/lines", { jar, body: { variantId: m.variant.id, quantity: 2 } })).status, 200)
  if (code) assert.equal((await api("POST", "/promotion", { jar, body: { code } })).status, 200)
  const contact = (await api("PUT", "/contact", { jar, body: { email: "Buyer@Example.com", shippingAddress: address() } })).json.data
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  assert.ok(quote?.id, "the API priced the bag")
  const row = await ctx.db.checkoutQuote.findUniqueOrThrow({ where: { id: quote.id } })
  const cart = await ctx.db.cart.findUniqueOrThrow({ where: { id: quote.cartId } })
  const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
  const catalogue = new Map(made.map(m => [m.variant.id, { handle: m.product.handle, imageUrl: m.product.media[0].url }]))
  const order = await ctx.db.order.create({ data: snapshots.orderCreateData({ quote, contact, owner, fingerprint: row.fingerprint, submitKey: randomUUID(), catalogue }), include: { items: { orderBy: { createdAt: "asc" } } } })
  return { jar, made, contact, quote, row, owner, order }
}

const reload = id => ctx.db.order.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sku: "asc" } } } })
/** Everything the order was sold on: every column except the status fields and the timestamp. */
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))
const sold = o => ({ ...without(o, ["status", "fulfilmentStatus", "updatedAt", "items"]), items: o.items.map(item => without(item, ["variantId"])) })
const rejects = (promise, what) => assert.rejects(promise, /purchase snapshot|violates check constraint/, what)

before(async () => {
  ctx = await setup("chaanavya_test_s13_order_snapshots")
  forward = ctx.routes.me.GET
  snapshots = await apiModule("orders/snapshot")
  const { user } = await createStaff(ctx, "s13.snapshot.owner@example.com", "OWNER")
  const profile = await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  profileId = profile.id
  await ctx.db.promotion.create({ data: { code: "ORDER10", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - 86_400_000), active: true } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M01 an order placed from a quote carries everything it was sold on", () => {
  test("identifiers: a UUID id and a CHV- number from the sequence, both unique", async () => {
    const a = (await placed()).order
    const b = (await placed()).order
    assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUID v7")
    assert.match(a.number, /^CHV-[0-9]{6,}$/)
    assert.notEqual(a.number, b.number)
    assert.ok(Number(b.number.slice(4)) > Number(a.number.slice(4)), "numbers come from one sequence")
  })

  test("the order is the quote, copied: totals, lines, tax classification, customer, tax basis, delivery and fingerprint", async () => {
    const { quote, row, contact, order, made } = await placed({ items: 2, code: "ORDER10" })
    assert.deepEqual(
      [order.subtotalPaise, order.discountTotalPaise, order.shippingFeePaise, order.taxTotalPaise, order.grandTotalPaise].map(Number),
      [quote.subtotal, quote.discountTotal, quote.shippingFee, quote.taxTotal, quote.grandTotal].map(m => m.amountPaise),
    )
    assert.equal(order.pricesIncludeTax, quote.pricesIncludeTax)
    assert.equal(order.quoteRef, quote.id)
    assert.equal(order.quoteFingerprint, row.fingerprint, "bound to the exact quote the shopper saw")
    assert.equal(order.promotionId, quote.promotionId)
    assert.equal(order.email, "buyer@example.com")
    assert.deepEqual(order.shippingAddress, contact.shippingAddress)
    assert.deepEqual(order.customerSnapshot, { kind: "guest", email: "buyer@example.com", name: "Synthetic Buyer", phone: "+916000000000" })
    const c = quote.lines[0].classification
    assert.deepEqual(order.taxSnapshot, { taxProfileId: profileId, profileApproved: false, supply: "intra", sellerStateCode: "IN-KA", deliveryStateCode: "IN-KA", pricesIncludeTax: true, rounding: c.rounding })
    assert.deepEqual(order.shippingSnapshot, { serviceRef: quote.shipping.serviceRef, courierName: quote.shipping.courierName, mode: quote.shipping.mode, estimatedDeliveryDays: quote.shipping.estimatedDeliveryDays, fee: quote.shipping.fee, tax: quote.shipping.tax, total: quote.shipping.total, ratesMode: "test" })
    assert.equal(order.items.length, 2)
    quote.lines.forEach((line, i) => {
      const item = order.items.find(it => it.variantId === line.variantId)
      assert.deepEqual(
        [item.variantId, item.sku, item.productTitle, item.variantTitle, item.handle, item.imageUrl, item.hsnCode, item.quantity, Number(item.unitPricePaise), Number(item.discountPaise), Number(item.lineTotalPaise), item.currency],
        [line.variantId, line.sku, line.title, line.variantTitle, made[i].product.handle, made[i].product.media[0].url, "6204", 2, line.unitPrice.amountPaise, line.discount.amountPaise, line.lineTotal.amountPaise, "INR"],
      )
      assert.deepEqual(item.taxLines, line.tax)
      assert.equal(Number(item.taxPaise), line.tax.reduce((a, t) => a + t.amount.amountPaise, 0))
      assert.deepEqual(item.taxClassification, line.classification)
    })
  })

  test("the snapshot is a copy: changing the quote object afterwards changes nothing", async () => {
    const { quote, contact, owner, row, made } = await placed()
    const catalogue = new Map(made.map(m => [m.variant.id, { handle: m.product.handle, imageUrl: null }]))
    const data = snapshots.orderCreateData({ quote, contact, owner, fingerprint: row.fingerprint, submitKey: randomUUID(), catalogue })
    quote.shipping.fee.amountPaise = 1
    quote.shipping.tax[0].amount.amountPaise = 1
    quote.lines[0].classification.rateBasisPoints = 0
    contact.shippingAddress.line1 = "Changed Road"
    assert.notEqual(data.shippingSnapshot.fee.amountPaise, 1)
    assert.notEqual(data.shippingSnapshot.tax[0].amount.amountPaise, 1)
    assert.equal(data.items.create[0].taxClassification.rateBasisPoints, 500)
    assert.equal(data.shippingAddress.line1, "1 Example Road")
  })
})

describe("CHV-S13-M01 later catalogue edits do not alter a placed order", () => {
  test("price, titles, SKU, handle, photo, weight, restriction, tax rate and HSN, promotion and address all change; the order does not", async () => {
    const { order, made, jar } = await placed({ code: "ORDER10" })
    const before = sold(await reload(order.id))
    const { product: p, variant: v } = made[0]
    await ctx.db.productVariant.update({ where: { id: v.id }, data: { pricePaise: 99900n, title: "Medium", sku: `${v.sku}-renamed`, weightGrams: 5000 } })
    await ctx.db.product.update({ where: { id: p.id }, data: { title: "Renamed fixture", handle: `${p.handle}-renamed`, shippingRestriction: "fragrance_liquid" } })
    await ctx.db.productMedia.update({ where: { id: p.media[0].id }, data: { url: "https://media.example.test/replaced.jpg" } })
    await ctx.db.taxRate.update({ where: { profileId_taxCategory: { profileId, taxCategory: "apparel_cotton" } }, data: { rateBasisPoints: 1200, hsnCode: "6211" } })
    await ctx.db.promotion.update({ where: { code: "ORDER10" }, data: { percentBasisPoints: 5000 } })
    assert.equal((await api("PUT", "/contact", { jar, body: { email: "someone.else@example.com", shippingAddress: address("400001", "IN-MH") } })).status, 200)
    try {
      assert.deepEqual(sold(await reload(order.id)), before, "nothing the order was sold on moved")
    } finally {
      await ctx.db.taxRate.update({ where: { profileId_taxCategory: { profileId, taxCategory: "apparel_cotton" } }, data: { rateBasisPoints: 500, hsnCode: "6204" } })
      await ctx.db.promotion.update({ where: { code: "ORDER10" }, data: { percentBasisPoints: 1000 } })
    }
  })

  test("archiving or deleting the variant keeps the snapshot; only the link to a deleted variant clears", async () => {
    const { order, made } = await placed()
    const before = sold(await reload(order.id))
    await ctx.db.productVariant.update({ where: { id: made[0].variant.id }, data: { archivedAt: new Date() } })
    assert.deepEqual(sold(await reload(order.id)), before)
    await ctx.db.cartLine.deleteMany({ where: { variantId: made[0].variant.id } })
    await ctx.db.inventoryBalance.delete({ where: { variantId: made[0].variant.id } })
    await ctx.db.productVariant.delete({ where: { id: made[0].variant.id } })
    const after = await reload(order.id)
    assert.equal(after.items[0].variantId, null)
    assert.deepEqual(sold(after), before)
  })
})

describe("CHV-S13-M01 the database refuses any edit of what was sold", () => {
  test("money, email, address, snapshots, fingerprint, number and tax setting cannot be changed on the order", async () => {
    const { order } = await placed()
    const edit = data => ctx.db.order.update({ where: { id: order.id }, data })
    await rejects(edit({ grandTotalPaise: order.grandTotalPaise - 1n, subtotalPaise: order.subtotalPaise - 1n }), "total")
    await rejects(edit({ shippingFeePaise: 0n, grandTotalPaise: order.grandTotalPaise - order.shippingFeePaise }), "fee")
    await rejects(edit({ email: "other@example.com" }), "email")
    await rejects(edit({ shippingAddress: { ...order.shippingAddress, line1: "Elsewhere" } }), "address")
    await rejects(edit({ customerSnapshot: { ...order.customerSnapshot, name: "Someone" } }), "customer")
    await rejects(edit({ taxSnapshot: { ...order.taxSnapshot, supply: "inter" } }), "tax basis")
    await rejects(edit({ shippingSnapshot: { ...order.shippingSnapshot, courierName: "Other" } }), "delivery")
    await rejects(edit({ quoteFingerprint: "0".repeat(64) }), "fingerprint")
    await rejects(edit({ quoteRef: randomUUID() }), "quote")
    await rejects(edit({ number: "CHV-999999" }), "number")
    await rejects(edit({ submitKey: randomUUID() }), "submit key")
    await rejects(ctx.db.$executeRaw`UPDATE "order" SET "created_at" = now() - interval '1 day' WHERE id = ${order.id}::uuid`, "placed time")
    assert.deepEqual(sold(await reload(order.id)), sold(order))
  })

  test("a line's price, tax, quantity or tax classification cannot be changed", async () => {
    const { order } = await placed()
    const item = order.items[0]
    const edit = data => ctx.db.orderItem.update({ where: { id: item.id }, data })
    await rejects(edit({ unitPricePaise: 1n }), "price")
    await rejects(edit({ quantity: 1 }), "quantity")
    await rejects(edit({ taxLines: [] }), "tax lines")
    await rejects(edit({ taxClassification: { ...item.taxClassification, rateBasisPoints: 0 } }), "classification")
    await rejects(edit({ productTitle: "Other" }), "title")
  })

  test("status, fulfilment and account links still move: a guest claims the order, and deletions clear links", async () => {
    const { order } = await placed()
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: order.id }, data: { status: "cancelled" } }))
    // A cancelled order's fulfilment can only be cancelled too (Stage 13.06 refuses packing an unconfirmed order).
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: order.id }, data: { fulfilmentStatus: "cancelled" } }))
    const buyer = await ctx.db.user.create({ data: { email: `s13.buyer.${randomUUID().slice(0, 8)}@example.com` } })
    const other = await ctx.db.user.create({ data: { email: `s13.other.${randomUUID().slice(0, 8)}@example.com` } })
    await ctx.db.order.update({ where: { id: order.id }, data: { userId: buyer.id } })
    await rejects(ctx.db.order.update({ where: { id: order.id }, data: { userId: other.id } }), "moving an order to another account")
    await ctx.db.user.delete({ where: { id: buyer.id } })
    assert.equal((await reload(order.id)).userId, null, "deleting the account clears the link")
    await ctx.db.order.update({ where: { id: order.id }, data: { guestSessionId: null } })
    const session = await ctx.db.guestSession.findFirstOrThrow()
    await rejects(ctx.db.order.update({ where: { id: order.id }, data: { guestSessionId: session.id } }), "attaching another guest session")
    const after = await reload(order.id)
    assert.deepEqual([after.status, after.fulfilmentStatus], ["cancelled", "cancelled"])
    assert.deepEqual(sold(after), { ...sold(order), userId: null, guestSessionId: null })
  })

  test("an order from a quote must carry every snapshot, consistent with its own columns; the number has its format", async () => {
    const { quote, contact, owner, row, made } = await placed()
    const catalogue = new Map(made.map(m => [m.variant.id, { handle: m.product.handle, imageUrl: null }]))
    const base = () => snapshots.orderCreateData({ quote, contact, owner, fingerprint: row.fingerprint, submitKey: randomUUID(), catalogue })
    const create = data => ctx.db.order.create({ data })
    await rejects(create({ ...base(), taxSnapshot: undefined }), "no tax snapshot")
    await rejects(create({ ...base(), shippingSnapshot: undefined }), "no delivery snapshot")
    await rejects(create({ ...base(), customerSnapshot: { ...base().customerSnapshot, email: "someone@example.com" } }), "customer email differs from the order's")
    await rejects(create({ ...base(), shippingSnapshot: { ...base().shippingSnapshot, fee: { amountPaise: 1, currency: "INR" } } }), "delivery fee differs")
    await rejects(create({ ...base(), taxSnapshot: { ...base().taxSnapshot, pricesIncludeTax: false } }), "tax setting differs")
    await rejects(create({ ...base(), quoteFingerprint: "not-a-digest" }), "fingerprint format")
    await rejects(create({ ...base(), number: "ORDER-1" }), "number format")
  })

  test("the same submit key never makes a second order", async () => {
    const { quote, contact, owner, row, made } = await placed()
    const catalogue = new Map(made.map(m => [m.variant.id, { handle: m.product.handle, imageUrl: null }]))
    const key = randomUUID()
    // A second order from the same quote is already refused (13.02); this checks the key alone, on a fresh quote reference.
    const quoteRef = randomUUID()
    const data = () => ({ ...snapshots.orderCreateData({ quote, contact, owner, fingerprint: row.fingerprint, submitKey: key, catalogue }), quoteRef })
    await ctx.db.order.create({ data: data() })
    await assert.rejects(ctx.db.order.create({ data: data() }), /Unique constraint|submit_key/)
    assert.equal(await ctx.db.order.count({ where: { submitKey: key } }), 1)
  })
})

describe("CHV-S13-M01 the snapshot is copied faithfully or not at all", () => {
  test("no fingerprint, no catalogue facts for a line, no lines, or lines taxed by two profiles are refused", async () => {
    const { quote, contact, owner, row, made } = await placed()
    const catalogue = new Map(made.map(m => [m.variant.id, { handle: m.product.handle, imageUrl: null }]))
    const build = overrides => () => snapshots.orderCreateData({ quote, contact, owner, fingerprint: row.fingerprint, submitKey: randomUUID(), catalogue, ...overrides })
    assert.throws(build({ fingerprint: "" }), /fingerprint/)
    assert.throws(build({ catalogue: new Map() }), /no catalogue facts/)
    assert.throws(build({ quote: { ...quote, lines: [] } }), /at least one line/)
    const twoProfiles = { ...quote, lines: [quote.lines[0], { ...quote.lines[0], classification: { ...quote.lines[0].classification, taxProfileId: randomUUID() } }] }
    assert.throws(build({ quote: twoProfiles }), /one profile/)
  })

  test("a signed-in customer's order is recorded as a customer's", async () => {
    const { quote, contact, row, made } = await placed()
    const user = await ctx.db.user.create({ data: { email: "buyer@example.com", emailVerified: true } })
    const catalogue = new Map(made.map(m => [m.variant.id, { handle: m.product.handle, imageUrl: null }]))
    // placed() already made the guest's order from this quote (one order per quote, 13.02): this one gets its own quote reference.
    const order = await ctx.db.order.create({ data: { ...snapshots.orderCreateData({ quote, contact, owner: { kind: "customer", customerId: user.id }, fingerprint: row.fingerprint, submitKey: randomUUID(), catalogue }), quoteRef: randomUUID() } })
    assert.deepEqual([order.userId, order.guestSessionId, order.customerSnapshot.kind], [user.id, null, "customer"])
  })
})
