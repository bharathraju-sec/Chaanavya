// Stage 08 catalogue administration, through the web forwarder against the NestJS API, with the
// local photo store (S3Mock) for uploads.
//   CHV-S08-001  non-admin and unauthorised staff cannot create, edit or publish products
//   CHV-S08-002  duplicate SKUs and option collisions are rejected without partial writes
//   CHV-S08-003  drafts, unapproved products and pending photos stay out of public reads
//   CHV-S08-004  upload abuse, unsupported media and unauthorised signed operations are rejected
//   CHV-S08-005  price edits never change historical order line snapshots
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { orderData, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, MEDIA_BASE, mediaStoreReady, png, readyDraft, sha256, sizes, uploadPhoto } from "./helpers.mjs"

let ctx, c, customer, staff, admin, owner, collections

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s08_catalogue")
  c = catalogueApi(ctx)
  customer = await signInCustomer(ctx, "s08.customer@example.com")
  staff = await staffWithMfa(ctx, "s08.staff@example.com", "STAFF")
  admin = await staffWithMfa(ctx, "s08.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s08.owner@example.com", "OWNER")
  collections = Object.fromEntries((await ctx.db.collection.findMany()).map(row => [row.handle, row.id]))
})
after(() => ctx?.teardown())

let counter = 0
const unique = prefix => `${prefix}-${process.pid}-${++counter}`.toUpperCase()

/** A draft created by an ADMIN with variants and one approved photo: ready for the owner to publish. */
async function readyProduct({ collection = "ethnic-festive", restriction = "none", sku = unique("KUR"), title } = {}) {
  const created = await c.create(admin.jar, readyDraft([collections[collection]], { shippingRestriction: restriction, ...(title && { title }) }))
  assert.equal(created.status, 201, JSON.stringify(created.json))
  const id = created.json.data.id
  const saved = await c.variants(admin.jar, id, created.json.data.etag, sizes(sku))
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  const photo = await uploadPhoto(c, admin.jar, id, png(600, 800))
  assert.equal(photo.completed.status, 200, JSON.stringify(photo.completed.json))
  const pending = photo.completed.json.data.media.at(-1)
  const approved = await c.approve(owner.jar, pending.id, photo.completed.json.data.etag)
  assert.equal(approved.status, 200, JSON.stringify(approved.json))
  return approved.json.data
}

const publish = (product, jar = owner.jar, checklist = fullChecklist) => c.status(jar, product.id, "publish", product.etag, { reason: "owner approved the listing", checklist })

describe("CHV-S08-001 only the right staff can create, edit and publish", () => {
  test("visitors get 401 and customers 403 on every catalogue admin route", async () => {
    const product = await readyProduct()
    const calls = [
      jar => c.list(jar),
      jar => c.get(jar, product.id),
      jar => c.create(jar, readyDraft([])),
      jar => c.update(jar, product.id, product.etag, { title: "Changed" }),
      jar => c.variants(jar, product.id, product.etag, sizes(unique("X"))),
      jar => c.status(jar, product.id, "publish", product.etag, { reason: "owner approved the listing", checklist: fullChecklist }),
      jar => c.intent(jar, product.id, { contentType: "image/png", byteSize: 10, checksumSha256: sha256(Buffer.from("x")) }),
      jar => c.collections(jar),
      jar => c.exportCsv(jar),
    ]
    for (const run of calls) {
      assert.equal((await run(undefined)).status, 401)
      assert.equal((await run(customer)).status, 403)
    }
    assert.equal((await c.get(owner.jar, product.id)).json.data.title, "Handloom cotton kurta", "nothing changed")
  })

  test("STAFF can read the catalogue but not create, edit, upload, import or publish", async () => {
    const product = await readyProduct()
    assert.equal((await c.list(staff.jar)).status, 200)
    assert.equal((await c.get(staff.jar, product.id)).status, 200)
    assert.equal((await c.create(staff.jar, readyDraft([]))).status, 403)
    assert.equal((await c.update(staff.jar, product.id, product.etag, { title: "Changed" })).status, 403)
    assert.equal((await c.variants(staff.jar, product.id, product.etag, sizes(unique("X")))).status, 403)
    assert.equal((await c.intent(staff.jar, product.id, { contentType: "image/png", byteSize: 10, checksumSha256: sha256(Buffer.from("x")) })).status, 403)
    assert.equal((await c.preview(staff.jar, "handle,sku\n")).status, 403)
    assert.equal((await publish(product, staff.jar)).status, 403)
  })

  test("ADMIN edits drafts but cannot publish, approve photos or change a live product", async () => {
    const product = await readyProduct()
    assert.equal((await publish(product, admin.jar)).status, 403)
    const published = await publish(product)
    assert.equal(published.status, 200, JSON.stringify(published.json))
    const live = published.json.data
    const edit = await c.update(admin.jar, live.id, live.etag, { title: "Cheaper title", reason: "trying it" })
    assert.equal(edit.status, 403)
    const reprice = await c.variants(admin.jar, live.id, live.etag, sizes(live.variants[0].sku.replace(/-S$/, ""), "100"))
    assert.equal(reprice.status, 403)
    for (const action of ["unpublish", "archive"]) assert.equal((await c.status(admin.jar, live.id, action, live.etag, { reason: "admin attempt" })).status, 403)
    const denials = await ctx.db.auditEvent.count({ where: { action: "identity.access_denied", actorId: admin.user.id } })
    assert.ok(denials >= 3, "the guard audits refused publish attempts")
    const after = (await c.get(owner.jar, live.id)).json.data
    assert.equal(after.title, "Handloom cotton kurta")
    assert.equal(after.status, "active")
  })

  test("publishing needs a reason, the current ETag and every checklist item", async () => {
    const product = await readyProduct()
    assert.equal((await c.status(owner.jar, product.id, "publish", product.etag, { checklist: fullChecklist })).status, 400, "reason")
    assert.equal((await c.status(owner.jar, product.id, "publish", undefined, { reason: "ok to go", checklist: fullChecklist })).status, 428)
    assert.equal((await c.status(owner.jar, product.id, "publish", 'W/"stale"', { reason: "ok to go", checklist: fullChecklist })).status, 412)
    const partial = await publish(product, owner.jar, { claims: true, pricing: true, description: true, shipping: true })
    assert.equal(partial.status, 400)
    assert.ok(partial.json.error.fields["checklist.sizing"], "apparel needs the sizing confirmation")
    const ok = await publish(product)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.data.status, "active")
    assert.ok(ok.json.data.approvedAt)
    const event = await ctx.db.auditEvent.findFirst({ where: { action: "product.status_changed", entityId: product.id } })
    assert.equal(event.actorId, owner.user.id)
    assert.equal(event.reason, "owner approved the listing")
    assert.deepEqual([event.before.status, event.after.status], ["draft", "active"])
  })

  test("publish checks: real description, tax category, approved photo with alt text, shipping restriction, sizes", async () => {
    const created = (await c.create(admin.jar, { title: "Royal Oud eau de parfum", description: "short", collectionIds: [collections.fragrance], shippingRestriction: "none" })).json.data
    const saved = (await c.variants(admin.jar, created.id, created.etag, { options: [{ name: "Volume", values: ["50 ml"] }], variants: [{ options: { Volume: "50 ml" }, sku: unique("OUD"), pricePaise: "0" }] })).json.data
    const codes = saved.blockers.map(b => b.code)
    for (const code of ["description", "price", "tax", "media", "shipping"]) assert.ok(codes.includes(code), `${code} in ${codes}`)
    assert.ok(saved.blockers.some(b => /fragrance liquid/.test(b.message)), "fragrance must be marked as a liquid")
    assert.equal((await publish(saved)).status, 409)
    assert.equal((await c.get(owner.jar, created.id)).json.data.status, "draft")

    const jewellery = (await c.create(admin.jar, readyDraft([collections.jewellery], { title: "Pearl drop earrings", shippingRestriction: "none" }))).json.data
    assert.ok(jewellery.blockers.some(b => /jewellery high value/.test(b.message)))
    const dress = (await c.create(admin.jar, readyDraft([collections.dresses], { title: "Linen day dress" }))).json.data
    const noSize = (await c.variants(admin.jar, dress.id, dress.etag, { options: [{ name: "Colour", values: ["Indigo"] }], variants: [{ options: { Colour: "Indigo" }, sku: unique("DRS"), pricePaise: "349900", taxCategory: "apparel" }] })).json.data
    assert.ok(noSize.blockers.some(b => b.code === "sizing"))
  })

  test("synthetic and placeholder products can never be published", async () => {
    const product = await readyProduct({ title: "Synthetic test kurta" })
    assert.ok(product.blockers.some(b => b.code === "demonstration"))
    assert.equal((await publish(product)).status, 409)
  })

  test("once live, the handle is fixed and edits need the owner's reason", async () => {
    const live = (await publish(await readyProduct())).json.data
    assert.equal((await c.update(owner.jar, live.id, live.etag, { handle: "new-url" , reason: "rename"})).status, 409)
    assert.equal((await c.update(owner.jar, live.id, live.etag, { title: "Handloom cotton kurta, indigo" })).status, 400, "reason required")
    const ok = await c.update(owner.jar, live.id, live.etag, { title: "Handloom cotton kurta, indigo", reason: "colour in the title" })
    assert.equal(ok.status, 200)
    assert.ok(ok.json.data.handleLocked)
    const breaking = await c.update(owner.jar, live.id, ok.json.data.etag, { description: "", reason: "remove text" })
    assert.equal(breaking.status, 409, "a live product cannot be edited into an unpublishable state")
  })
})

describe("CHV-S08-002 SKU and option clashes are refused, with no partial writes", () => {
  test("the same SKU or the same options twice in one save is refused", async () => {
    const draft = (await c.create(admin.jar, readyDraft([collections.dresses], { title: "Wrap dress" }))).json.data
    const sku = unique("WRP")
    const twiceSku = await c.variants(admin.jar, draft.id, draft.etag, { options: [{ name: "Size", values: ["S", "M"] }], variants: [{ options: { Size: "S" }, sku, pricePaise: "100" }, { options: { Size: "M" }, sku: sku.toLowerCase(), pricePaise: "100" }] })
    assert.equal(twiceSku.status, 400)
    assert.ok(twiceSku.json.error.fields["variants.1.sku"])
    const twiceOptions = await c.variants(admin.jar, draft.id, draft.etag, { options: [{ name: "Size", values: ["S", "M"] }], variants: [{ options: { Size: "S" }, sku: `${sku}-1`, pricePaise: "100" }, { options: { size: "s" }, sku: `${sku}-2`, pricePaise: "100" }] })
    assert.equal(twiceOptions.status, 400)
    assert.ok(twiceOptions.json.error.fields["variants.1.options"])
    assert.equal(await ctx.db.productVariant.count({ where: { productId: draft.id } }), 0)
  })

  test("a SKU used by another product refuses the whole save: earlier rows are not written", async () => {
    const other = await readyProduct()
    const taken = other.variants[0].sku
    const draft = (await c.create(admin.jar, readyDraft([collections.dresses], { title: "Shirt dress" }))).json.data
    const first = (await c.variants(admin.jar, draft.id, draft.etag, sizes(unique("SHD")))).json.data
    const beforeVariants = await ctx.db.productVariant.findMany({ where: { productId: draft.id }, orderBy: { sku: "asc" } })
    const attempt = await c.variants(admin.jar, draft.id, first.etag, {
      options: [{ name: "Size", values: ["S", "M", "L"] }],
      variants: [
        { id: first.variants[0].id, options: { Size: "S" }, sku: first.variants[0].sku, pricePaise: "999900", taxCategory: "apparel" },
        { options: { Size: "L" }, sku: unique("NEW"), pricePaise: "100" },
        { id: first.variants[1].id, options: { Size: "M" }, sku: taken, pricePaise: "100" },
      ],
    })
    assert.equal(attempt.status, 409)
    assert.ok(attempt.json.error.fields["variants.2.sku"])
    assert.deepEqual(await ctx.db.productVariant.findMany({ where: { productId: draft.id }, orderBy: { sku: "asc" } }), beforeVariants, "no variant changed or was created")
    assert.equal((await c.get(admin.jar, draft.id)).json.data.etag, first.etag, "the product version did not move")
    assert.equal(await ctx.db.auditEvent.count({ where: { entityId: draft.id, action: "product.variants_saved" } }), 1, "only the first save was audited")
  })

  test("variants can swap SKUs, removed variants are archived and their options reused", async () => {
    const draft = (await c.create(admin.jar, readyDraft([collections.dresses], { title: "Tiered dress" }))).json.data
    const base = unique("TRD")
    const saved = (await c.variants(admin.jar, draft.id, draft.etag, sizes(base))).json.data
    const [s, m] = saved.variants
    const swapped = await c.variants(admin.jar, draft.id, saved.etag, { options: [{ name: "Size", values: ["S", "M"] }], variants: [{ id: s.id, options: { Size: "S" }, sku: m.sku, pricePaise: "100" }, { id: m.id, options: { Size: "M" }, sku: s.sku, pricePaise: "100" }] })
    assert.equal(swapped.status, 200, JSON.stringify(swapped.json))
    const onlyM = await c.variants(admin.jar, draft.id, swapped.json.data.etag, { options: [{ name: "Size", values: ["M"] }], variants: [{ id: m.id, options: { Size: "M" }, sku: s.sku, pricePaise: "100" }] })
    assert.equal(onlyM.json.data.variants.length, 1)
    assert.ok((await ctx.db.productVariant.findUnique({ where: { id: s.id } })).archivedAt, "removed, not deleted")
    const readded = await c.variants(admin.jar, draft.id, onlyM.json.data.etag, sizes(unique("TRD2")))
    assert.equal(readded.status, 200, JSON.stringify(readded.json))
  })

  test("a stale ETag is refused: two editors cannot overwrite each other", async () => {
    const draft = (await c.create(admin.jar, readyDraft([], { title: "Kaftan" }))).json.data
    assert.equal((await c.update(admin.jar, draft.id, draft.etag, { title: "Kaftan one" })).status, 200)
    const stale = await c.update(owner.jar, draft.id, draft.etag, { title: "Kaftan two" })
    assert.equal(stale.status, 412)
    assert.equal((await c.update(owner.jar, draft.id, undefined, { title: "Kaftan two" })).status, 428)
    assert.equal((await c.get(admin.jar, draft.id)).json.data.title, "Kaftan one")
  })

  test("stock is never written by variant saves or imports", async () => {
    const product = await readyProduct()
    const variant = product.variants[0]
    await ctx.db.inventoryBalance.update({ where: { variantId: variant.id }, data: { onHand: 7 } })
    await c.variants(admin.jar, product.id, product.etag, { ...sizes(variant.sku.replace(/-S$/, ""), "259900"), variants: product.variants.map(v => ({ id: v.id, options: v.options, sku: v.sku, pricePaise: "259900", taxCategory: "apparel" })) })
    assert.equal((await ctx.db.inventoryBalance.findUnique({ where: { variantId: variant.id } })).onHand, 7)
  })
})

describe("CHV-S08-003 nothing unapproved reaches public reads", () => {
  test("drafts, archived products and unknown handles read the same 404; live products are listed", async () => {
    const draft = await readyProduct()
    assert.equal((await c.publicGet(draft.handle)).status, 404)
    assert.ok(!(await c.publicList()).json.data.some(p => p.id === draft.id))
    const live = (await publish(draft)).json.data
    assert.equal((await c.publicGet(live.handle)).status, 404, "live but not yet counted (Stage 09)")
    await countStock(c, admin.jar, owner.jar, live.variants.map(v => ({ sku: v.sku, counted: 3 })))
    const shown = await c.publicGet(live.handle)
    assert.equal(shown.status, 200)
    assert.equal(shown.json.data.status, "active")
    assert.ok((await c.publicList("?collection=ethnic-festive")).json.data.some(p => p.id === live.id))
    const archived = (await c.status(owner.jar, live.id, "archive", live.etag, { reason: "range ended" })).json.data
    assert.equal(archived.status, "archived")
    const gone = await c.publicGet(live.handle)
    assert.equal(gone.status, 404)
    assert.deepEqual(gone.json, (await c.publicGet("no-such-product")).json)
  })

  test("pending, rejected and removed photos are never public; approved ones are", async () => {
    const live = (await publish(await readyProduct())).json.data
    await countStock(c, admin.jar, owner.jar, live.variants.map(v => ({ sku: v.sku, counted: 1 })))
    const pending = await uploadPhoto(c, admin.jar, live.id, png(500, 500, [10, 20, 30]))
    const rejectedUpload = await uploadPhoto(c, admin.jar, live.id, png(500, 500, [40, 50, 60]))
    const rejectId = rejectedUpload.completed.json.data.media.at(-1).id
    const rejected = await c.reject(owner.jar, rejectId, rejectedUpload.completed.json.data.etag)
    assert.equal(rejected.status, 200)
    const publicMedia = (await c.publicGet(live.handle)).json.data.media
    assert.equal(publicMedia.length, 1, "only the approved photo")
    assert.ok(publicMedia[0].url.startsWith(`${MEDIA_BASE}public/products/${live.id}/`))
    const pendingRow = await ctx.db.productMedia.findFirst({ where: { productId: live.id, status: "pending" } })
    assert.equal(pendingRow.url, null, "a pending photo has no public URL")
    assert.ok(pendingRow.stagingKey.startsWith("staging/"))
    assert.ok(pending.completed.json.data.media.find(m => m.status === "pending").previewUrl.includes("X-Amz-Signature"), "staff preview through a signed link")
    assert.equal((await ctx.db.productMedia.findUnique({ where: { id: rejectId } })).stagingKey, null)
  })

  test("hidden collections and their products stay out of public reads", async () => {
    const hidden = await c.createCollection(admin.jar, { handle: `secret-${counter++}`, title: "Next season" })
    assert.equal(hidden.status, 201)
    assert.equal(hidden.json.data.hidden, true, "new collections start hidden")
    assert.equal((await c.createCollection(admin.jar, { handle: `shown-${counter++}`, title: "Shown", hidden: false })).status, 403)
    assert.ok(!(await c.publicCollections()).json.data.some(col => col.id === hidden.json.data.id))
    assert.deepEqual((await c.publicList(`?collection=${hidden.json.data.handle}`)).json.data, [])
  })

  test("catalogue events: none for draft edits, one per live change, carrying handles only", async () => {
    const draft = await readyProduct()
    await c.update(admin.jar, draft.id, draft.etag, { productType: "Kurta set" })
    assert.equal(await ctx.db.outboxEvent.count({ where: { aggregateId: draft.id } }), 0, "draft edits are never announced")
    const live = (await publish((await c.get(owner.jar, draft.id)).json.data)).json.data
    const events = await ctx.db.outboxEvent.findMany({ where: { aggregateId: live.id } })
    assert.equal(events.length, 1)
    assert.equal(events[0].topic, "catalogue.updated")
    assert.deepEqual(Object.keys(events[0].payload).sort(), ["change", "collections", "handle", "productId"])
    assert.equal(events[0].payload.change, "published")
    await c.status(owner.jar, live.id, "unpublish", live.etag, { reason: "photo shoot redo" })
    assert.equal((await ctx.db.outboxEvent.findMany({ where: { aggregateId: live.id }, orderBy: { createdAt: "asc" } })).at(-1).payload.change, "unpublished")
  })

  test("storefront categories keep their URLs", async () => {
    const list = (await c.collections(admin.jar)).json.data
    const dresses = list.find(col => col.handle === "dresses")
    assert.deepEqual(list.filter(col => col.storefront).map(col => col.handle).sort(), ["dresses", "ethnic-festive", "fragrance", "jewellery"])
    assert.equal((await c.updateCollection(admin.jar, dresses.id, dresses.etag, { handle: "frocks" })).status, 409)
    await assert.rejects(ctx.db.collection.update({ where: { id: dresses.id }, data: { handle: "frocks" } }), /keeps its handle/)
    await assert.rejects(ctx.db.collection.delete({ where: { id: dresses.id } }), /cannot be deleted/)
    const renamed = await c.updateCollection(admin.jar, dresses.id, dresses.etag, { title: "Dresses and Gowns" })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.json.data.handle, "dresses")
  })
})

describe("CHV-S08-004 upload abuse is refused", () => {
  let draft
  before(async () => {
    draft = (await c.create(admin.jar, readyDraft([collections.dresses], { title: "Upload test dress" }))).json.data
  })

  test("unsupported types, oversized files and malformed checksums are refused before any upload", async () => {
    const ok = { contentType: "image/png", byteSize: 1000, checksumSha256: sha256(Buffer.from("a")) }
    for (const contentType of ["image/svg+xml", "image/gif", "text/html", "application/pdf", "image/heic"]) {
      assert.equal((await c.intent(admin.jar, draft.id, { ...ok, contentType })).status, 400, contentType)
    }
    assert.equal((await c.intent(admin.jar, draft.id, { ...ok, byteSize: 10 * 1024 * 1024 + 1 })).status, 400)
    assert.equal((await c.intent(admin.jar, draft.id, { ...ok, byteSize: 0 })).status, 400)
    assert.equal((await c.intent(admin.jar, draft.id, { ...ok, checksumSha256: "not-a-checksum" })).status, 400)
    assert.equal(await ctx.db.mediaUpload.count({ where: { productId: draft.id } }), 0)
  })

  test("the signed upload fixes type, exact length and checksum, expires in 10 minutes and targets private staging", async () => {
    const bytes = png(600, 600)
    const intent = (await c.intent(admin.jar, draft.id, { contentType: "image/png", byteSize: bytes.length, checksumSha256: sha256(bytes) })).json.data
    const url = new URL(intent.upload.url)
    assert.deepEqual(url.searchParams.get("X-Amz-SignedHeaders").split(";").sort(), ["content-length", "content-type", "host", "x-amz-checksum-sha256"])
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600")
    assert.match(url.pathname, new RegExp(`/chaanavya-media/staging/${draft.id}/${intent.uploadId}$`))
    const different = Buffer.from(bytes)
    different[different.length - 20] ^= 0xff
    const wrongBytes = await fetch(intent.upload.url, { method: "PUT", body: different, headers: intent.upload.headers })
    assert.equal(wrongBytes.status, 400, "storage refuses bytes that do not match the signed checksum")
    assert.equal((await c.complete(admin.jar, intent.uploadId)).status, 409, "nothing was stored")
  })

  test("a file that is not the image it claims is refused and deleted, leaving no photo", async () => {
    const html = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">${"x".repeat(2000)}</svg>`)
    const fake = await uploadPhoto(c, admin.jar, draft.id, html, { contentType: "image/png" })
    assert.equal(fake.put.status, 200, "storage accepted the bytes the signature allowed")
    assert.equal(fake.completed.status, 400)
    assert.match(fake.completed.json.error.message, /not a JPEG, PNG, WebP or AVIF/)
    assert.equal((await fetch(`${MEDIA_BASE}staging/${draft.id}/${fake.uploadId}`)).status, 404, "the staged file was deleted")
    const pngAsJpeg = await uploadPhoto(c, admin.jar, draft.id, png(600, 600), { contentType: "image/jpeg" })
    assert.equal(pngAsJpeg.completed.status, 400)
    assert.match(pngAsJpeg.completed.json.error.message, /image\/png, not image\/jpeg/)
    const tiny = await uploadPhoto(c, admin.jar, draft.id, png(40, 40))
    assert.equal(tiny.completed.status, 400)
    assert.match(tiny.completed.json.error.message, /at least 400 pixels/)
    const truncated = await uploadPhoto(c, admin.jar, draft.id, png(600, 600).subarray(0, 60))
    assert.equal(truncated.completed.status, 400)
    assert.match(truncated.completed.json.error.message, /incomplete or has extra data/)
    const appended = await uploadPhoto(c, admin.jar, draft.id, Buffer.concat([png(600, 600), Buffer.from("PK hidden archive")]))
    assert.equal(appended.completed.status, 400, "data hidden after the image is refused")
    assert.equal(await ctx.db.productMedia.count({ where: { productId: draft.id } }), 0)
  })

  test("intents belong to their creator, work once and expire", async () => {
    const bytes = png(600, 600, [1, 2, 3])
    const intent = (await c.intent(admin.jar, draft.id, { contentType: "image/png", byteSize: bytes.length, checksumSha256: sha256(bytes) })).json.data
    await fetch(intent.upload.url, { method: "PUT", body: bytes, headers: intent.upload.headers })
    assert.equal((await c.complete(owner.jar, intent.uploadId)).status, 404, "another staff member cannot complete it")
    assert.equal((await c.complete(staff.jar, intent.uploadId)).status, 403)
    assert.equal((await c.complete(customer, intent.uploadId)).status, 403)
    assert.equal((await c.complete(admin.jar, intent.uploadId)).status, 200)
    assert.equal((await c.complete(admin.jar, intent.uploadId)).status, 409, "only once")

    const late = (await c.intent(admin.jar, draft.id, { contentType: "image/png", byteSize: bytes.length, checksumSha256: sha256(bytes) })).json.data
    await ctx.db.mediaUpload.update({ where: { id: late.uploadId }, data: { createdAt: new Date(Date.now() - 20 * 60 * 1000), expiresAt: new Date(Date.now() - 10 * 60 * 1000) } })
    assert.equal((await c.complete(admin.jar, late.uploadId)).status, 409)
    assert.equal((await c.complete(admin.jar, "00000000-0000-4000-8000-000000000000")).status, 404)
  })

  test("approving and rejecting photos needs catalogue.publish; open intents are limited", async () => {
    const photo = await uploadPhoto(c, admin.jar, draft.id, png(700, 700))
    const media = photo.completed.json.data.media.find(m => m.status === "pending")
    assert.equal((await c.approve(admin.jar, media.id, photo.completed.json.data.etag)).status, 403)
    assert.equal((await c.reject(admin.jar, media.id, photo.completed.json.data.etag)).status, 403)
    assert.equal((await c.approve(owner.jar, media.id, 'W/"stale"')).status, 412)
    assert.equal((await ctx.db.productMedia.findUnique({ where: { id: media.id } })).status, "pending")
    // A separate ADMIN, so the limit does not affect the other tests.
    const uploader = await staffWithMfa(ctx, "s08.uploader@example.com", "ADMIN")
    const answers = []
    for (let i = 0; i < 11; i++) answers.push((await c.intent(uploader.jar, draft.id, { contentType: "image/png", byteSize: 100, checksumSha256: sha256(Buffer.from([i])) })).status)
    assert.deepEqual(answers, [...Array(10).fill(201), 429])
  })
})

describe("CHV-S08-005 price edits never change order snapshots", () => {
  test("repricing a live variant is audited and leaves earlier order lines untouched", async () => {
    const live = (await publish(await readyProduct())).json.data
    const variant = live.variants[0]
    const order = await ctx.db.order.create({
      data: orderData({
        email: "s08.buyer@example.com",
        subtotalPaise: BigInt(variant.pricePaise),
        grandTotalPaise: BigInt(variant.pricePaise),
        items: { create: [{ variantId: variant.id, sku: variant.sku, productTitle: live.title, variantTitle: variant.title, handle: live.handle, quantity: 1, unitPricePaise: BigInt(variant.pricePaise), lineTotalPaise: BigInt(variant.pricePaise) }] },
      }),
      include: { items: true },
    })
    const snapshot = order.items[0]
    const body = { options: live.options, variants: live.variants.map(v => ({ id: v.id, options: v.options, sku: v.sku, pricePaise: v.id === variant.id ? "199900" : v.pricePaise, taxCategory: v.taxCategory })), reason: "festive price" }
    assert.equal((await c.variants(owner.jar, live.id, live.etag, { ...body, reason: undefined })).status, 400, "a live price change needs a reason")
    const repriced = await c.variants(owner.jar, live.id, live.etag, body)
    assert.equal(repriced.status, 200, JSON.stringify(repriced.json))
    assert.equal(repriced.json.data.variants.find(v => v.id === variant.id).pricePaise, "199900")
    const renamed = await c.update(owner.jar, live.id, repriced.json.data.etag, { title: "Renamed kurta", reason: "new name" })
    assert.equal(renamed.status, 200)
    assert.deepEqual(await ctx.db.orderItem.findUnique({ where: { id: snapshot.id } }), snapshot, "the order line is exactly as bought")
    const audit = await ctx.db.auditEvent.findFirst({ where: { action: "price.changed", entityId: variant.id } })
    assert.deepEqual([audit.before.pricePaise, audit.after.pricePaise, audit.reason], [variant.pricePaise, "199900", "festive price"])
  })

  test("the database refuses any change to an order line's snapshot", async () => {
    const live = (await publish(await readyProduct())).json.data
    const variant = live.variants[0]
    const order = await ctx.db.order.create({
      data: orderData({ items: { create: [{ variantId: variant.id, sku: variant.sku, productTitle: live.title, variantTitle: variant.title, handle: live.handle, quantity: 1, unitPricePaise: BigInt(199900), lineTotalPaise: BigInt(199900) }] } }),
      include: { items: true },
    })
    const id = order.items[0].id
    for (const data of [{ unitPricePaise: BigInt(1) }, { productTitle: "Edited" }, { sku: "OTHER" }, { quantity: 2 }, { variantId: live.variants[1].id }]) {
      await assert.rejects(ctx.db.orderItem.update({ where: { id }, data }), /purchase snapshot/, JSON.stringify(Object.keys(data)))
    }
    await ctx.db.orderItem.update({ where: { id }, data: { variantId: null } })
    assert.equal((await ctx.db.orderItem.findUnique({ where: { id } })).variantId, null, "only unlinking a deleted variant is allowed")
  })
})

describe("CSV import and export", () => {
  const header = "handle,title,description,product_type,tags,collections,shipping_restriction,sku,option1_name,option1_value,price,compare_at_price,tax_category"

  test("preview reports every error and writes nothing; stock columns are refused", async () => {
    const sku = unique("IMP")
    const csv = [
      header,
      `import-saree-${counter},Banarasi silk saree,,Saree,silk;festive,ethnic-festive,none,${sku}-A,Colour,Red,"12,999.00",,apparel`,
      `import-saree-${counter},Banarasi silk saree,,Saree,silk;festive,ethnic-festive,none,${sku}-A,Colour,Blue,12999,,apparel`,
      `import-saree-${counter},Banarasi silk saree,,Saree,,ethnic-festive,none,${sku}-B,Colour,Red,abc,,apparel`,
      `Bad Handle!,X,,,,,,${sku}-C,,,100,,`,
      `import-other-${counter},Other,,,,no-such-collection,none,${sku}-D,,,100,50,`,
    ].join("\n")
    const before = await ctx.db.product.count()
    const preview = await c.preview(admin.jar, csv)
    assert.equal(preview.status, 200)
    const messages = preview.json.data.errors.map(e => `${e.row}:${e.field}`)
    for (const expected of ["3:sku", "4:price", "5:handle", "6:collections", "6:compareAtPricePaise"]) assert.ok(messages.some(m => m.startsWith(expected.split(":")[0])), `${expected} in ${messages}`)
    assert.equal(preview.json.data.token, null)
    assert.equal(await ctx.db.product.count(), before)
    const stock = await c.preview(admin.jar, `${header},stock\nx,X,,,,,,${sku}-E,,,100,,,5`)
    assert.ok(stock.json.data.errors.some(e => e.field === "stock" && /never imported/.test(e.message)))
  })

  test("a clean file is previewed, then committed in one transaction as drafts; a changed catalogue needs a new preview", async () => {
    const sku = unique("IMQ")
    const handle = `import-lehenga-${counter}`
    const csv = [header, `${handle},Bridal lehenga,"Hand-embroidered, with ""zari"" work",Lehenga,bridal,ethnic-festive,none,${sku}-S,Size,S,"45,000",,apparel`, `${handle},Bridal lehenga,,,,,,${sku}-M,Size,M,45000.50,,apparel`].join("\r\n")
    const preview = (await c.preview(admin.jar, csv)).json.data
    assert.deepEqual(preview.errors, [])
    assert.deepEqual(preview.summary, { productsCreated: 1, productsUpdated: 0, variantsCreated: 2, variantsUpdated: 0 })
    assert.deepEqual(preview.products[0].variants.map(v => v.pricePaise), ["4500000", "4500050"])
    assert.equal((await c.commit(admin.jar, csv, "wrong-token")).status, 409)
    assert.equal(await ctx.db.product.count({ where: { handle } }), 0)
    const committed = await c.commit(admin.jar, csv, preview.token)
    assert.equal(committed.status, 200, JSON.stringify(committed.json))
    const product = await ctx.db.product.findUnique({ where: { handle }, include: { variants: true } })
    assert.equal(product.status, "draft", "imports never publish")
    assert.equal(product.description, 'Hand-embroidered, with "zari" work')
    assert.equal(product.variants.length, 2)
    const balances = await ctx.db.inventoryBalance.findMany({ where: { variantId: { in: product.variants.map(v => v.id) } } })
    assert.ok(balances.every(b => b.onHand === 0))
    assert.ok(await ctx.db.auditEvent.findFirst({ where: { action: "catalogue.imported", actorId: admin.user.id } }))

    const second = `${header}\n${handle},Bridal lehenga,,,,,,${sku}-S,Size,S,46000,,apparel`
    const plan = (await c.preview(admin.jar, second)).json.data
    assert.equal(plan.products[0].variants[0].beforePricePaise, "4500000")
    const view = (await c.get(admin.jar, product.id)).json.data
    await c.update(admin.jar, product.id, view.etag, { productType: "Bridal lehenga" })
    assert.equal((await c.commit(admin.jar, second, plan.token)).status, 409, "the product changed after the preview")
  })

  test("live products are not imported over; export guards against spreadsheet formulas", async () => {
    const live = (await publish(await readyProduct())).json.data
    const csv = `${header}\n${live.handle},New title,,,,,,${live.variants[0].sku},Size,S,1,,apparel`
    const preview = (await c.preview(admin.jar, csv)).json.data
    assert.ok(preview.errors.some(e => /live/.test(e.message)))
    const draft = (await c.create(admin.jar, readyDraft([], { title: "Formula test", description: "=HYPERLINK(\"http://evil.example\")" }))).json.data
    const exported = await c.exportCsv(admin.jar)
    assert.equal(exported.status, 200)
    assert.match(exported.response.headers.get("content-disposition"), /attachment; filename="chaanavya-catalogue-/)
    const line = exported.json.split("\r\n").find(l => l.startsWith(draft.handle))
    assert.ok(line.includes(`"'=HYPERLINK(""http://evil.example"")"`), line)
  })
})
