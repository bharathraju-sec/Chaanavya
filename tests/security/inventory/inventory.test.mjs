// Stage 09 inventory API through the web forwarder against the NestJS API:
//   CHV-S09-003  stock adjustment, ledger row and audit event commit or roll back together
//   CHV-S09-004  repeated imports are idempotent, report discrepancies, never make demo goods live
// plus permissions, ETags, idempotency keys, stocktake approval and the public-display gate.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, call, orderData, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "../catalogue/helpers.mjs"

let ctx, c, customer, staff, admin, owner, collections

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s09_inventory_api")
  c = catalogueApi(ctx)
  customer = await signInCustomer(ctx, "s09.customer@example.com")
  staff = await staffWithMfa(ctx, "s09.staff@example.com", "STAFF")
  admin = await staffWithMfa(ctx, "s09.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s09.owner@example.com", "OWNER")
  collections = Object.fromEntries((await ctx.db.collection.findMany()).map(row => [row.handle, row.id]))
})
after(() => ctx?.teardown())

const forward = () => ctx.routes.me.GET
const api = (method, path, { jar, body, etag, key } = {}) => call(forward(), `/api/admin/inventory${path}`, { method, jar, body, headers: { ...(etag && { "if-match": etag }), ...(key && { "idempotency-key": key }) } })
const stock = (jar, id) => api("GET", `/stock/${id}`, { jar })

let n = 0
/** A published product with two sizes and an approved photo; its stock is not counted yet. */
async function liveProduct() {
  const prefix = `INV${process.pid}${++n}`
  const created = (await c.create(admin.jar, readyDraft([collections["ethnic-festive"]], { title: `Inventory kurta ${n}` }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const pending = photo.completed.json.data.media.at(-1)
  const approved = (await c.approve(owner.jar, pending.id, photo.completed.json.data.etag)).json.data
  const live = await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "ready", checklist: fullChecklist })
  assert.equal(live.status, 200, JSON.stringify(live.json))
  return { ...live.json.data, skus: saved.variants.map(v => v.sku), variantIds: saved.variants.map(v => v.id) }
}

/** Counts and approves: owner signs, accepting every discrepancy. */
async function countAndApprove(lines, { by = admin, approver = owner, accept = lines.map(l => l.sku) } = {}) {
  const started = (await api("POST", "/stocktakes", { jar: by.jar, body: { note: "test count" } })).json.data
  const filled = (await api("PUT", `/stocktakes/${started.id}/lines`, { jar: by.jar, etag: started.etag, body: { lines } })).json.data
  const submitted = (await api("POST", `/stocktakes/${started.id}/submit`, { jar: by.jar, etag: filled.etag })).json.data
  return api("POST", `/stocktakes/${started.id}/approve`, { jar: approver.jar, etag: submitted.etag, body: { signedName: "Test Owner", acceptedSkus: accept, statement: true, reason: "first physical count" } })
}

describe("permissions and record rules", () => {
  test("visitors 401, customers 403, STAFF read only, ADMIN cannot approve stocktakes", async () => {
    const p = await liveProduct()
    const id = p.variantIds[0]
    const etag = (await stock(owner.jar, id)).json.data.etag
    for (const jar of [undefined, customer]) {
      assert.equal((await stock(jar, id)).status, jar ? 403 : 401)
      assert.equal((await api("POST", `/stock/${id}/receive`, { jar, etag, body: { quantity: 1, reason: "delivery" } })).status, jar ? 403 : 401)
    }
    assert.equal((await stock(staff.jar, id)).status, 200)
    assert.equal((await api("GET", "/stock", { jar: staff.jar })).status, 200)
    assert.equal((await api("POST", `/stock/${id}/receive`, { jar: staff.jar, etag, body: { quantity: 1, reason: "delivery" } })).status, 403)
    assert.equal((await api("POST", "/stocktakes", { jar: staff.jar, body: {} })).status, 403)
    const adminApproval = await countAndApprove([{ sku: p.skus[0], counted: 1 }], { approver: admin })
    assert.equal(adminApproval.status, 403)
    assert.equal((await stock(owner.jar, id)).json.data.onHand, 0, "nothing applied")
  })

  test("changes need a reason and the current ETag; an Idempotency-Key makes a retry harmless", async () => {
    const p = await liveProduct()
    const id = p.variantIds[0]
    const first = (await stock(admin.jar, id)).json.data
    assert.equal((await api("POST", `/stock/${id}/receive`, { jar: admin.jar, etag: first.etag, body: { quantity: 5 } })).status, 400, "reason")
    assert.equal((await api("POST", `/stock/${id}/receive`, { jar: admin.jar, body: { quantity: 5, reason: "delivery" } })).status, 428)
    assert.equal((await api("POST", `/stock/${id}/receive`, { jar: admin.jar, etag: 'W/"old"', body: { quantity: 5, reason: "delivery" } })).status, 412)
    for (const bad of [0, -1, 1.5, "x", 100001]) assert.equal((await api("POST", `/stock/${id}/receive`, { jar: admin.jar, etag: first.etag, body: { quantity: bad, reason: "delivery" } })).status, 400, String(bad))
    const key = `receive-${process.pid}-${n}`
    const once = await api("POST", `/stock/${id}/receive`, { jar: admin.jar, etag: first.etag, key, body: { quantity: 5, reason: "delivery 1042" } })
    assert.equal(once.status, 200, JSON.stringify(once.json))
    const retry = await api("POST", `/stock/${id}/receive`, { jar: admin.jar, etag: first.etag, key, body: { quantity: 5, reason: "delivery 1042" } })
    assert.equal(retry.status, 200)
    assert.equal(retry.json.data.onHand, 5, "the retry did not add another 5")
    assert.equal(await ctx.db.inventoryMovement.count({ where: { variantId: id, type: "receipt" } }), 1)
  })
})

describe("CHV-S09-003 stock change, ledger and audit are one unit", () => {
  test("receive, adjust and write-off each write one ledger row with the balance after it, and one audit event", async () => {
    const p = await liveProduct()
    const id = p.variantIds[0]
    let view = (await stock(admin.jar, id)).json.data
    view = (await api("POST", `/stock/${id}/receive`, { jar: admin.jar, etag: view.etag, body: { quantity: 10, reason: "delivery 7" } })).json.data
    view = (await api("POST", `/stock/${id}/adjust`, { jar: admin.jar, etag: view.etag, body: { delta: -2, reasonCode: "damaged", reason: "two torn at the hem" } })).json.data
    const written = await api("POST", `/stock/${id}/write-off`, { jar: admin.jar, etag: view.etag, body: { quantity: 1, reasonCode: "sample", reason: "photo shoot sample" } })
    assert.equal(written.status, 200)
    assert.deepEqual([written.json.data.onHand, written.json.data.available], [7, 7])
    const history = (await api("GET", `/stock/${id}/movements`, { jar: staff.jar })).json.data
    assert.deepEqual(history.map(m => [m.type, m.quantity, m.onHandAfter, m.reasonCode]), [["write_off", -1, 7, "sample"], ["correction", -2, 8, "damaged"], ["receipt", 10, 10, "receipt"]])
    const audits = await ctx.db.auditEvent.findMany({ where: { entityId: id, action: { in: ["inventory.received", "inventory.adjusted", "inventory.written_off"] } } })
    assert.equal(audits.length, 3)
    assert.ok(audits.every(a => a.actorId === admin.user.id && a.reason.length >= 3))
  })

  test("a change that fails part-way leaves no ledger row, no audit event and the same balance", async () => {
    const p = await liveProduct()
    const id = p.variantIds[0]
    const view = (await stock(admin.jar, id)).json.data
    const tooMany = await api("POST", `/stock/${id}/write-off`, { jar: admin.jar, etag: view.etag, body: { quantity: 3, reasonCode: "lost", reason: "missing after move" } })
    assert.equal(tooMany.status, 409)
    // The audit step itself fails (no correlation ID) after the ledger row was written: all of it is undone.
    const { receive } = await apiModule("inventory/stock")
    const { db } = await apiModule("db/client")
    await assert.rejects(receive(db(), id, view.etag, 4, { actor: { kind: "staff", id: admin.user.id }, correlationId: "", reason: "delivery", idempotencyKey: null }), /correlation id/)
    const after = (await stock(admin.jar, id)).json.data
    assert.deepEqual([after.onHand, after.etag], [0, view.etag])
    assert.equal(await ctx.db.inventoryMovement.count({ where: { variantId: id } }), 0)
    assert.equal(await ctx.db.auditEvent.count({ where: { entityId: id, action: { startsWith: "inventory." } } }), 0)
  })

  test("the ledger cannot be edited or deleted, and a signed stocktake cannot change", async () => {
    const p = await liveProduct()
    const approved = await countAndApprove([{ sku: p.skus[0], counted: 3 }])
    assert.equal(approved.status, 200, JSON.stringify(approved.json))
    const movement = await ctx.db.inventoryMovement.findFirst({ where: { variantId: p.variantIds[0] } })
    await assert.rejects(ctx.db.inventoryMovement.update({ where: { id: movement.id }, data: { quantity: 99 } }), /append-only/)
    await assert.rejects(ctx.db.inventoryMovement.delete({ where: { id: movement.id } }), /append-only/)
    await assert.rejects(ctx.db.stocktake.update({ where: { id: approved.json.data.id }, data: { note: "edited" } }), /signed record/)
    await assert.rejects(ctx.db.stocktakeLine.updateMany({ where: { stocktakeId: approved.json.data.id }, data: { counted: 99 } }), /signed record/)
  })
})

describe("stocktakes and the public-display gate", () => {
  test("a live product stays off the shop until its stock is counted and signed; discrepancies must each be accepted", async () => {
    const p = await liveProduct()
    assert.equal((await c.publicGet(p.handle)).status, 404, "published but never counted")
    const unaccepted = await countAndApprove([{ sku: p.skus[0], counted: 4, note: "shelf B" }, { sku: p.skus[1], counted: 0 }], { accept: [] })
    assert.equal(unaccepted.status, 409)
    assert.ok(unaccepted.json.error.fields[`accept.${p.skus[0]}`])
    const draftId = (await api("GET", "/stocktakes", { jar: owner.jar })).json.data[0].id
    const submitted = (await api("GET", `/stocktakes/${draftId}`, { jar: owner.jar })).json.data
    assert.equal(submitted.status, "submitted")
    assert.equal(submitted.report.totals.discrepancies, 1, "counting 0 of 0 is not a discrepancy")
    const signed = await api("POST", `/stocktakes/${draftId}/approve`, { jar: owner.jar, etag: submitted.etag, body: { signedName: "Test Owner", acceptedSkus: [p.skus[0]], statement: true, reason: "first count" } })
    assert.equal(signed.status, 200, JSON.stringify(signed.json))
    assert.equal(signed.json.data.report.approval.signedName, "Test Owner")
    const shown = await c.publicGet(p.handle)
    assert.equal(shown.status, 200)
    assert.deepEqual(shown.json.data.variants.map(v => v.availableForSale), [true, false], "S has 4, M has none")
    assert.ok(!JSON.stringify(shown.json).includes('"onHand"'), "stock levels stay private")
    const s = (await stock(staff.jar, p.variantIds[0])).json.data
    assert.deepEqual([s.onHand, s.sellable, Boolean(s.lastCountedAt)], [4, true, true])
    assert.ok(await ctx.db.auditEvent.findFirst({ where: { action: "stocktake.approved", entityId: draftId, actorId: owner.user.id } }))
  })

  test("approval needs the statement and a typed name; a count below units held for orders is refused", async () => {
    const p = await liveProduct()
    const started = (await api("POST", "/stocktakes", { jar: admin.jar, body: {} })).json.data
    const filled = (await api("PUT", `/stocktakes/${started.id}/lines`, { jar: admin.jar, etag: started.etag, body: { lines: [{ sku: p.skus[0], counted: 2 }] } })).json.data
    const submitted = (await api("POST", `/stocktakes/${started.id}/submit`, { jar: admin.jar, etag: filled.etag })).json.data
    const ask = body => api("POST", `/stocktakes/${started.id}/approve`, { jar: owner.jar, etag: submitted.etag, body: { signedName: "Test Owner", acceptedSkus: [p.skus[0]], statement: true, reason: "count", ...body } })
    assert.equal((await ask({ statement: false })).status, 400)
    assert.equal((await ask({ signedName: "" })).status, 400)
    assert.equal((await api("PUT", `/stocktakes/${started.id}/lines`, { jar: admin.jar, etag: submitted.etag, body: { lines: [] } })).status, 409, "submitted lines are frozen")
    assert.equal((await ask({})).status, 200)
    assert.equal((await ask({})).status, 412, "approving twice is impossible")

    // Both counted units are now held for an order; a recount of 1 cannot be approved.
    const { reserveStock } = await apiModule("inventory/reservations")
    const { db } = await apiModule("db/client")
    const order = await ctx.db.order.create({ data: orderData() })
    assert.ok((await reserveStock(db(), { orderId: order.id, lines: [{ variantId: p.variantIds[0], quantity: 2 }], idempotencyKey: `hold-${order.id}`, correlationId: "test" })).ok)
    const recount = await countAndApprove([{ sku: p.skus[0], counted: 1 }])
    assert.equal(recount.status, 409)
    assert.match(recount.json.error.message, /held for paid or pending orders/)
    assert.equal((await stock(staff.jar, p.variantIds[0])).json.data.onHand, 2)
  })

  test("SKU search, never-counted and low-stock filters", async () => {
    const p = await liveProduct()
    const uncounted = (await api("GET", "/stock?uncounted=1&limit=100", { jar: staff.jar })).json.data
    assert.ok(uncounted.some(s => s.sku === p.skus[0]))
    await countAndApprove([{ sku: p.skus[0], counted: 2 }])
    const view = (await stock(admin.jar, p.variantIds[0])).json.data
    assert.equal((await api("PATCH", `/stock/${p.variantIds[0]}`, { jar: admin.jar, etag: view.etag, body: { lowStockThreshold: 3 } })).status, 200)
    const low = (await api("GET", "/stock?lowStock=1", { jar: staff.jar })).json.data
    assert.ok(low.some(s => s.sku === p.skus[0] && s.lowStock && s.available === 2))
    assert.deepEqual((await api("GET", `/stock?search=${p.skus[0]}`, { jar: staff.jar })).json.data.map(s => s.sku), [p.skus[0]])
  })
})

describe("CHV-S09-004 imports are idempotent and never make demo goods live", () => {
  test("the same count file twice returns the same stocktake; approving it twice is impossible", async () => {
    const p = await liveProduct()
    const csv = `sku,counted,note\n${p.skus[0]},6,back room\n${p.skus[1]},1,\n`
    const first = await api("POST", "/stocktakes/import", { jar: admin.jar, body: { csv, source: "owner_csv", note: "October count" } })
    assert.equal(first.status, 200, JSON.stringify(first.json))
    assert.equal(first.response.headers.get("x-import-result"), "created")
    const again = await api("POST", "/stocktakes/import", { jar: admin.jar, body: { csv, source: "owner_csv" } })
    assert.equal(again.response.headers.get("x-import-result"), "existing")
    assert.equal(again.json.data.id, first.json.data.id)
    const submitted = (await api("POST", `/stocktakes/${first.json.data.id}/submit`, { jar: admin.jar, etag: first.json.data.etag })).json.data
    assert.equal(submitted.report.totals.discrepancies, 2)
    const ok = await api("POST", `/stocktakes/${first.json.data.id}/approve`, { jar: owner.jar, etag: submitted.etag, body: { signedName: "Test Owner", acceptedSkus: p.skus, statement: true, reason: "October count" } })
    assert.equal(ok.status, 200)
    const third = await api("POST", "/stocktakes/import", { jar: admin.jar, body: { csv, source: "owner_csv" } })
    assert.equal(third.json.data.status, "approved", "re-importing an applied file changes nothing")
    assert.equal((await stock(staff.jar, p.variantIds[0])).json.data.onHand, 6)
    assert.equal(await ctx.db.inventoryMovement.count({ where: { variantId: p.variantIds[0], reasonCode: "stocktake" } }), 1)
  })

  test("a Shopify export is reference only: counts start at zero and differences are reported", async () => {
    const p = await liveProduct()
    const csv = `Handle,Title,Variant SKU,Variant Inventory Qty,Variant Price\n${p.handle},Kurta,${p.skus[0]},12,2499.00\n${p.handle},,${p.skus[1]},3,2499.00\n`
    const draft = (await api("POST", "/stocktakes/import", { jar: admin.jar, body: { csv, source: "shopify_export" } })).json.data
    assert.equal(draft.source, "shopify_export")
    const bySku = Object.fromEntries(draft.report.lines.map(l => [l.sku, [l.counted, l.reference, l.difference]]))
    assert.deepEqual(bySku, { [p.skus[0]]: [0, 12, 0], [p.skus[1]]: [0, 3, 0] }, "counts start at zero; Shopify's figure is only a reference")
    assert.equal((await stock(staff.jar, p.variantIds[0])).json.data.onHand, 0, "nothing applied by importing")
  })

  test("synthetic, placeholder and unknown SKUs are refused; nothing is created", async () => {
    const before = await ctx.db.stocktake.count()
    const synthetic = await ctx.db.productVariant.create({ data: { product: { create: { handle: `synthetic-${n}`, title: "Synthetic product", status: "active" } }, sku: `SYN-${process.pid}-${n}`, title: "S", optionKey: "default", pricePaise: BigInt(100) } })
    await ctx.db.inventoryBalance.create({ data: { variantId: synthetic.id } })
    for (const csv of [`sku,counted\n${synthetic.sku},5\n`, "sku,counted\nNO-SUCH-SKU,5\n", "sku,counted\nA,-1\n", "sku\nA\n"]) {
      const answer = await api("POST", "/stocktakes/import", { jar: admin.jar, body: { csv } })
      assert.equal(answer.status, 400, csv)
    }
    assert.match((await api("POST", "/stocktakes/import", { jar: admin.jar, body: { csv: `sku,counted\n${synthetic.sku},5\n` } })).json.error.message, /synthetic or placeholder/)
    assert.equal(await ctx.db.stocktake.count(), before)
    assert.equal((await ctx.db.inventoryBalance.findUnique({ where: { variantId: synthetic.id } })).lastCountedAt, null, "demo stock is never counted, so never sellable")
  })
})
