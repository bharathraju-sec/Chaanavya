// Helpers for the Stage 08 catalogue tests: admin API calls through the web forwarder, real PNG
// fixtures, and the local photo store (compose `media`, S3Mock; `npm run db:up` starts it).
import { createHash } from "node:crypto"
import { crc32, deflateSync } from "node:zlib"
import { call } from "../auth/helpers.mjs"

export const MEDIA_BASE = "http://127.0.0.1:9090/chaanavya-media/"

/** Waits for the local photo store; S3Mock creates its bucket a few seconds after start. */
export async function mediaStoreReady() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(MEDIA_BASE)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error("the local photo store is not running: npm run db:up")
}

/** A valid PNG of the given size (solid colour), built by hand so the tests need no image library. */
export function png(width, height, rgb = [180, 90, 60]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

export const sha256 = bytes => createHash("sha256").update(bytes).digest("base64")

/** Admin and public API calls as a browser on the shop host would make them. */
export function catalogueApi(ctx) {
  const forward = ctx.routes.me.GET
  const api = (method, path, { jar, body, etag, headers = {} } = {}) => call(forward, path, { method, jar, body, headers: { ...(etag && { "if-match": etag }), ...headers } })
  const base = "/api/admin/catalogue"
  return {
    api,
    list: (jar, query = "") => api("GET", `${base}/products${query}`, { jar }),
    get: (jar, id) => api("GET", `${base}/products/${id}`, { jar }),
    create: (jar, body) => api("POST", `${base}/products`, { jar, body }),
    update: (jar, id, etag, body) => api("PATCH", `${base}/products/${id}`, { jar, etag, body }),
    variants: (jar, id, etag, body) => api("PUT", `${base}/products/${id}/variants`, { jar, etag, body }),
    status: (jar, id, action, etag, body) => api("POST", `${base}/products/${id}/${action}`, { jar, etag, body }),
    intent: (jar, id, body) => api("POST", `${base}/products/${id}/media/uploads`, { jar, body }),
    complete: (jar, uploadId, body = {}) => api("POST", `${base}/media/uploads/${uploadId}/complete`, { jar, body }),
    approve: (jar, mediaId, etag) => api("POST", `${base}/media/${mediaId}/approve`, { jar, etag, body: {} }),
    reject: (jar, mediaId, etag, reason = "blurry photo") => api("POST", `${base}/media/${mediaId}/reject`, { jar, etag, body: { reason } }),
    editMedia: (jar, mediaId, etag, body) => api("PATCH", `${base}/media/${mediaId}`, { jar, etag, body }),
    removeMedia: (jar, mediaId, etag, body = {}) => api("DELETE", `${base}/media/${mediaId}`, { jar, etag, body }),
    collections: jar => api("GET", `${base}/collections`, { jar }),
    createCollection: (jar, body) => api("POST", `${base}/collections`, { jar, body }),
    updateCollection: (jar, id, etag, body) => api("PATCH", `${base}/collections/${id}`, { jar, etag, body }),
    preview: (jar, csv) => api("POST", `${base}/import/preview`, { jar, body: { csv } }),
    commit: (jar, csv, token, reason = "first range from the owner") => api("POST", `${base}/import/commit`, { jar, body: { csv, token, reason } }),
    exportCsv: jar => api("GET", `${base}/export`, { jar }),
    publicList: (query = "") => api("GET", `/api/catalogue/products${query}`),
    publicGet: handle => api("GET", `/api/catalogue/products/${handle}`),
    publicCollections: () => api("GET", "/api/catalogue/collections"),
  }
}

/** Uploads a file through an intent: the signed PUT straight to storage, then completion. */
export async function uploadPhoto(c, jar, productId, bytes, { contentType = "image/png", declared = {}, altText = "Front view of the product" } = {}) {
  const intent = await c.intent(jar, productId, { contentType, byteSize: bytes.length, checksumSha256: sha256(bytes), ...declared })
  if (intent.status !== 201) return { intent }
  const { upload, uploadId } = intent.json.data
  const put = await fetch(upload.url, { method: "PUT", body: bytes, headers: upload.headers })
  const completed = await c.complete(jar, uploadId, { altText })
  return { intent, put, completed, uploadId }
}

/** A draft that passes every publish check once its photo is approved. */
export const readyDraft = (collectionIds, overrides = {}) => ({
  title: "Handloom cotton kurta",
  description: "A handloom cotton kurta with a straight cut, side slits and mother-of-pearl buttons.",
  productType: "Kurta",
  tags: ["cotton"],
  shippingRestriction: "none",
  collectionIds,
  ...overrides,
})

export const sizes = (prefix, pricePaise = "249900") => ({
  options: [{ name: "Size", values: ["S", "M"] }],
  variants: [
    { options: { Size: "S" }, sku: `${prefix}-S`, pricePaise, taxCategory: "apparel" },
    { options: { Size: "M" }, sku: `${prefix}-M`, pricePaise, taxCategory: "apparel" },
  ],
})

/** Stage 09: a live product is public only once its stock is counted and signed. Counts and approves. */
export async function countStock(c, adminJar, ownerJar, lines) {
  const inv = (method, path, jar, body, etag) => c.api(method, `/api/admin/inventory${path}`, { jar, body, etag })
  const started = (await inv("POST", "/stocktakes", adminJar, {})).json.data
  const filled = (await inv("PUT", `/stocktakes/${started.id}/lines`, adminJar, { lines }, started.etag)).json.data
  const submitted = (await inv("POST", `/stocktakes/${started.id}/submit`, adminJar, undefined, filled.etag)).json.data
  const approved = await inv("POST", `/stocktakes/${started.id}/approve`, ownerJar, { signedName: "Test Owner", acceptedSkus: lines.map(l => l.sku), statement: true, reason: "test count" }, submitted.etag)
  if (approved.status !== 200) throw new Error(`stocktake approval failed: ${approved.status} ${JSON.stringify(approved.json)}`)
  return approved.json.data
}

export const fullChecklist = { claims: true, pricing: true, description: true, sizing: true, shipping: true }
