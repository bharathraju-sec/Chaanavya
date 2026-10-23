// Product photo uploads (Stage 08):
//
//   1. intent    staff with catalogue.write ask for an upload: type, exact size and SHA-256. The API
//                records an intent (10 minutes) and returns a signed PUT for private staging.
//   2. upload    the browser PUTs the file straight to the bucket; the signature fixes type, length
//                and checksum, so the bucket refuses anything else.
//   3. complete  the same staff member asks the API to verify: the stored object must have the
//                declared size, checksum, type and real image dimensions. Then it becomes a pending
//                photo. Anything wrong deletes the object and leaves no photo.
//   4. review    staff with catalogue.publish approve (copied to public/, staging deleted) or reject
//                (staging deleted). Only approved photos ever reach shoppers.
//
// Removed photos keep their files for 7 days (cached pages may still show them); the worker then
// deletes them, and deletes the staging objects of intents that were never completed.
import { randomUUID } from "node:crypto"
import { ApiError } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db, Tx } from "../db/client.ts"
import { writeOutbox } from "../outbox/outbox.ts"
import type { Change } from "../catalogue/products.ts"
import { productEtag } from "../catalogue/products.ts"
import { text } from "../catalogue/rules.ts"
import { inspectImage, isMediaType, MEDIA_LIMITS, MEDIA_TYPES } from "./inspect.ts"
import { mediaStorage, publicKey, stagingKey, type MediaStorage } from "./storage.ts"

export const UPLOAD_TTL_SECONDS = 10 * 60
/** Open upload intents per staff member at once (abandoned uploads expire after 10 minutes). */
export const MAX_OPEN_UPLOADS = 10
const CHECKSUM = /^[A-Za-z0-9+/]{43}=$/

const staffId = (change: Change) => {
  if (change.actor.kind !== "staff") throw new ApiError(403, "forbidden", "uploads need a staff session")
  return change.actor.id
}

export function uploadRequest(body: Record<string, unknown>) {
  if (!isMediaType(body.contentType)) throw new ApiError(400, "invalid_request", `photos must be ${Object.keys(MEDIA_TYPES).join(", ")}`, { contentType: "unsupported" })
  const byteSize = Number(body.byteSize)
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > MEDIA_LIMITS.maxBytes) throw new ApiError(400, "invalid_request", `photos must be 1 byte to ${MEDIA_LIMITS.maxBytes / 1024 / 1024} MB`, { byteSize: "out of range" })
  if (typeof body.checksumSha256 !== "string" || !CHECKSUM.test(body.checksumSha256)) throw new ApiError(400, "invalid_request", "checksumSha256 must be the file's base64 SHA-256", { checksumSha256: "invalid" })
  return { contentType: body.contentType, byteSize, checksumSha256: body.checksumSha256 }
}

export async function createUpload(db: Db, productId: string, file: ReturnType<typeof uploadRequest>, change: Change, storage: MediaStorage = mediaStorage()) {
  const createdById = staffId(change)
  const product = await db.product.findUnique({ where: { id: productId }, select: { status: true, _count: { select: { media: { where: { removedAt: null } } } } } })
  if (!product) throw new ApiError(404, "not_found", "not found")
  if (product.status === "archived") throw new ApiError(409, "conflict", "restore the product before adding photos")
  if (product._count.media >= MEDIA_LIMITS.perProduct) throw new ApiError(409, "conflict", `a product can have up to ${MEDIA_LIMITS.perProduct} photos`)
  const open = await db.mediaUpload.count({ where: { createdById, completedAt: null, expiresAt: { gt: new Date() } } })
  if (open >= MAX_OPEN_UPLOADS) throw new ApiError(429, "rate_limited", "finish or wait for your other uploads first")
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000)
  const id = randomUUID()
  const key = stagingKey(productId, id)
  const intent = await db.mediaUpload.create({ data: { id, productId, stagingKey: key, ...file, createdById, expiresAt } })
  const signed = await storage.signUpload(key, file, UPLOAD_TTL_SECONDS)
  return { uploadId: intent.id, expiresAt: expiresAt.toISOString(), upload: signed }
}

/** Verifies the uploaded object and turns the intent into a pending photo. */
export async function completeUpload(db: Db, uploadId: string, body: Record<string, unknown>, change: Change, storage: MediaStorage = mediaStorage()) {
  const createdById = staffId(change)
  const altText = body.altText === undefined ? null : text(body.altText, "altText", { max: 300 }) || null
  const intent = await db.mediaUpload.findUnique({ where: { id: uploadId } })
  // Someone else's intent reads like a missing one: intents are not shared between staff.
  if (!intent || intent.createdById !== createdById) throw new ApiError(404, "not_found", "not found")
  if (intent.completedAt) throw new ApiError(409, "conflict", "this upload was already completed")
  if (intent.expiresAt <= new Date()) throw new ApiError(409, "conflict", "this upload expired; start again")

  const fail = async (problem: string) => {
    await storage.remove(intent.stagingKey).catch(() => {})
    await db.mediaUpload.update({ where: { id: intent.id }, data: { completedAt: new Date() } })
    throw new ApiError(400, "invalid_request", problem, { file: problem })
  }
  const stored = await storage.head(intent.stagingKey)
  if (!stored) throw new ApiError(409, "conflict", "the file has not been uploaded yet")
  if (stored.byteSize !== intent.byteSize) return fail("the file is not the declared size")
  if (stored.contentType !== intent.contentType) return fail("the file was stored with a different type")
  const bytes = await storage.read(intent.stagingKey, MEDIA_LIMITS.maxBytes).catch(() => null)
  if (!bytes) return fail("the file could not be read")
  const checked = inspectImage(bytes, intent)
  if (!checked.ok) return fail(checked.problem)

  return db.$transaction(async tx => {
    // Claim the intent first: a second, concurrent completion finds it taken and stops here.
    const { count } = await tx.mediaUpload.updateMany({ where: { id: intent.id, completedAt: null }, data: { completedAt: new Date() } })
    if (count !== 1) throw new ApiError(409, "conflict", "this upload was already completed")
    const product = await tx.product.findUniqueOrThrow({ where: { id: intent.productId }, select: { id: true, version: true, media: { where: { removedAt: null }, select: { position: true } } } })
    const position = Math.max(-1, ...product.media.map(m => m.position)) + 1
    const media = await tx.productMedia.create({
      data: { productId: intent.productId, status: "pending", stagingKey: intent.stagingKey, contentType: intent.contentType, byteSize: intent.byteSize, checksumSha256: intent.checksumSha256, width: checked.width, height: checked.height, altText, position },
    })
    await tx.mediaUpload.update({ where: { id: intent.id }, data: { mediaId: media.id } })
    await tx.product.update({ where: { id: product.id }, data: { version: { increment: 1 } } })
    await recordAdminEvent(tx, { action: "media.uploaded", actor: change.actor, entity: { type: "product_media", id: media.id }, reason: change.reason ?? "", after: { productId: intent.productId, byteSize: intent.byteSize, contentType: intent.contentType }, correlationId: change.correlationId })
    return media.id
  })
}

/** Loads a photo and its product for a review or edit, checking the product's If-Match. */
async function beginMedia(tx: Tx, mediaId: string, ifMatch: string | undefined) {
  const media = await tx.productMedia.findUnique({ where: { id: mediaId }, include: { product: { select: { id: true, version: true, status: true, handle: true } } } })
  if (!media || media.removedAt) throw new ApiError(404, "not_found", "not found")
  if (!ifMatch) throw new ApiError(428, "precondition_required", "If-Match header required: load the product first")
  if (ifMatch !== productEtag(media.product)) throw new ApiError(412, "precondition_failed", "the product changed since you loaded it; reload and try again")
  const { count } = await tx.product.updateMany({ where: { id: media.product.id, version: media.product.version }, data: { version: { increment: 1 } } })
  if (count !== 1) throw new ApiError(412, "precondition_failed", "the product changed since you loaded it; reload and try again")
  return media
}

async function announceMedia(tx: Tx, product: { id: string; status: string; handle: string }) {
  if (product.status !== "active") return
  const collections = await tx.productCollection.findMany({ where: { productId: product.id }, select: { collection: { select: { handle: true } } } })
  await writeOutbox(tx, "catalogue.updated", { type: "product", id: product.id }, { productId: product.id, handle: product.handle, collections: collections.map(c => c.collection.handle), change: "media" })
}

export async function approveMedia(db: Db, mediaId: string, ifMatch: string | undefined, change: Change, storage: MediaStorage = mediaStorage()) {
  if (!change.canPublish) throw new ApiError(403, "forbidden", "only staff who may publish can approve photos")
  const current = await db.productMedia.findUnique({ where: { id: mediaId } })
  if (!current || current.removedAt) throw new ApiError(404, "not_found", "not found")
  if (current.status !== "pending" || !current.stagingKey || !current.contentType) throw new ApiError(409, "conflict", `this photo is ${current.status}`)
  const key = publicKey(current.productId, current.id, MEDIA_TYPES[current.contentType as keyof typeof MEDIA_TYPES])
  // Copy first: if the database change then fails, an unreferenced public copy is harmless and the
  // photo stays pending. The staging object is deleted only after the approval commits.
  await storage.publish(current.stagingKey, key, current.contentType)
  await db.$transaction(async tx => {
    const media = await beginMedia(tx, mediaId, ifMatch)
    if (media.status !== "pending") throw new ApiError(409, "conflict", `this photo is ${media.status}`)
    await tx.productMedia.update({ where: { id: mediaId }, data: { status: "approved", url: storage.publicUrl(key), storageKey: key, stagingKey: null, approvedAt: new Date(), approvedById: staffId(change), version: { increment: 1 } } })
    await recordAdminEvent(tx, { action: "media.approved", actor: change.actor, entity: { type: "product_media", id: mediaId }, reason: change.reason ?? "", after: { productId: media.productId }, correlationId: change.correlationId })
    await announceMedia(tx, media.product)
  })
  await storage.remove(current.stagingKey).catch(() => {})
}

export async function rejectMedia(db: Db, mediaId: string, ifMatch: string | undefined, change: Change & { reason: string }, storage: MediaStorage = mediaStorage()) {
  if (!change.canPublish) throw new ApiError(403, "forbidden", "only staff who may publish can reject photos")
  const stagingObject = await db.$transaction(async tx => {
    const media = await beginMedia(tx, mediaId, ifMatch)
    if (media.status !== "pending") throw new ApiError(409, "conflict", `this photo is ${media.status}`)
    await tx.productMedia.update({ where: { id: mediaId }, data: { status: "rejected", stagingKey: null, version: { increment: 1 } } })
    await tx.productVariant.updateMany({ where: { mediaId }, data: { mediaId: null } })
    await recordAdminEvent(tx, { action: "media.rejected", actor: change.actor, entity: { type: "product_media", id: mediaId }, reason: change.reason, after: { productId: media.productId }, correlationId: change.correlationId })
    return media.stagingKey
  })
  if (stagingObject) await storage.remove(stagingObject).catch(() => {})
}

/**
 * Alt text and order. `position` inserts the photo at that place: photos at or after it move one
 * along. Changing a live product's photo needs catalogue.publish and a reason.
 */
export async function updateMedia(db: Db, mediaId: string, ifMatch: string | undefined, body: Record<string, unknown>, change: Change) {
  const data: { altText?: string | null; position?: number } = {}
  if ("altText" in body) data.altText = text(body.altText, "altText", { max: 300 }) || null
  if ("position" in body) {
    const position = Number(body.position)
    if (!Number.isInteger(position) || position < 0 || position > 100) throw new ApiError(400, "invalid_request", "position must be 0 to 100", { position: "invalid" })
    data.position = position
  }
  await db.$transaction(async tx => {
    const media = await beginMedia(tx, mediaId, ifMatch)
    const live = media.product.status === "active" && media.status === "approved"
    if (live && !change.canPublish) throw new ApiError(403, "forbidden", "this photo is live; only staff who may publish can change it")
    if (live && !change.reason) throw new ApiError(400, "invalid_request", "a reason is required to change a live photo", { reason: "required" })
    if (live && "altText" in data && !data.altText) throw new ApiError(409, "conflict", "a live photo needs alt text", { altText: "required" })
    if (data.position !== undefined) {
      await tx.productMedia.updateMany({ where: { productId: media.productId, id: { not: mediaId }, position: { gte: data.position } }, data: { position: { increment: 1 } } })
    }
    await tx.productMedia.update({ where: { id: mediaId }, data: { ...data, version: { increment: 1 } } })
    await recordAdminEvent(tx, { action: "media.updated", actor: change.actor, entity: { type: "product_media", id: mediaId }, reason: change.reason ?? "", after: { fields: Object.keys(data).sort().join(",") }, correlationId: change.correlationId })
    if (live) await announceMedia(tx, media.product)
  })
}

/** Takes a photo off the product. Its files are deleted by the worker after the grace period. */
export async function removeMedia(db: Db, mediaId: string, ifMatch: string | undefined, change: Change) {
  await db.$transaction(async tx => {
    const media = await beginMedia(tx, mediaId, ifMatch)
    const live = media.product.status === "active" && media.status === "approved"
    if (live && !change.canPublish) throw new ApiError(403, "forbidden", "this photo is live; only staff who may publish can remove it")
    if (live && !change.reason) throw new ApiError(400, "invalid_request", "a reason is required to remove a live photo", { reason: "required" })
    if (live) {
      const others = await tx.productMedia.count({ where: { productId: media.productId, status: "approved", removedAt: null, id: { not: mediaId } } })
      if (others === 0) throw new ApiError(409, "conflict", "a live product needs at least one photo; add another first or unpublish it")
    }
    await tx.productMedia.update({ where: { id: mediaId }, data: { removedAt: new Date(), version: { increment: 1 } } })
    await tx.productVariant.updateMany({ where: { mediaId }, data: { mediaId: null } })
    await recordAdminEvent(tx, { action: "media.removed", actor: change.actor, entity: { type: "product_media", id: mediaId }, reason: change.reason ?? "", before: { status: media.status }, after: { productId: media.productId }, correlationId: change.correlationId })
    if (live) await announceMedia(tx, media.product)
  })
}
