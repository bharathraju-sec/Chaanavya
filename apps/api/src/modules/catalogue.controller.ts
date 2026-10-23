// Catalogue administration API (Stage 08): products, variants, publishing, photos, collections and
// CSV import/export. Capabilities: catalogue.read (STAFF and up) to read, catalogue.write (ADMIN and
// OWNER) to edit drafts, upload photos and import, catalogue.publish (OWNER) to publish, unpublish,
// archive, approve or reject photos and edit what shoppers see. Every change needs the product's
// current ETag (If-Match) and writes its audit event in the same transaction.
import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { ApiError, decodeCursor, oneOf, parsePage, readJson, requireReason, uuidParam } from "../admin/api.ts"
import type { StaffActor } from "../auth/session.ts"
import { collectionFields, createCollection, listCollections, loadCollection, updateCollection } from "../catalogue/collections.ts"
import { commitImport, exportCatalogue, IMPORT_MAX_BYTES, planImport, summaryOf } from "../catalogue/import.ts"
import { changeStatus, createProduct, listProducts, loadProduct, productFields, saveVariants, updateProduct, type Change, type StatusAction } from "../catalogue/products.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import { queryOf, type ApiRequest } from "../http/context.ts"
import { CatalogueSchemas, data, list } from "../http/schemas.ts"
import { approveMedia, completeUpload, createUpload, rejectMedia, removeMedia, updateMedia, uploadRequest } from "../media/uploads.ts"

const ifMatch = { name: "If-Match", required: true, description: "The product's ETag from GET /api/v1/admin/catalogue/products/{id}" }
const isAfter = (v: unknown): v is { createdAt: string; id: string } => typeof (v as { id?: unknown })?.id === "string" && typeof (v as { createdAt?: unknown })?.createdAt === "string"

/** A reason when given; required by the service for live changes. */
function optionalReason(body: Record<string, unknown>) {
  if (body.reason === undefined || body.reason === null || body.reason === "") return null
  return requireReason(body)
}

function changeOf(staff: StaffActor, req: ApiRequest, reason: string | null): Change {
  return { actor: { kind: "staff", id: staff.userId }, correlationId: req.chaanavya.correlationId, reason, canPublish: staff.capabilities.has("catalogue.publish") }
}

function send(res: Response, body: unknown, etag?: string) {
  res.setHeader("cache-control", "no-store")
  if (etag) res.setHeader("etag", etag)
  return body
}

const header = (req: ApiRequest) => (typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined)

@ApiTags("catalogue admin")
@Controller("api/v1/admin/catalogue")
export class CatalogueAdminController {
  // ---- products ----

  @Get("products")
  @Access.permission("catalogue.read")
  @ApiOperation({ summary: "Products, newest first, with search (title, handle or SKU), status and collection filters" })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "status", required: false, enum: ["draft", "active", "archived"] })
  @ApiQuery({ name: "collectionId", required: false })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(CatalogueSchemas.productListItem) })
  async products(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query)
    const status = query.get("status") ? oneOf(query.get("status"), ["draft", "active", "archived"] as const, "status") : null
    const collectionId = query.get("collectionId") ? uuidParam(query.get("collectionId")!) : null
    const search = query.get("search")?.slice(0, 100) ?? null
    const { items, nextCursor } = await listProducts(db(), { search, status, collectionId, limit, after: decodeCursor(cursor, isAfter) })
    return send(res, { data: items, page: { nextCursor } })
  }

  @Post("products")
  @HttpCode(201)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Create a draft product (the handle defaults to one made from the title)" })
  @ApiBody({ schema: CatalogueSchemas.productInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async create(@CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body, 32 * 1024)
    const id = await createProduct(db(), productFields(body, { creating: true }), changeOf(staff, req, optionalReason(body)))
    const view = await loadProduct(db(), id)
    return send(res, { data: view }, view.etag)
  }

  @Get("products/:id")
  @Access.permission("catalogue.read")
  @ApiOperation({ summary: "One product with variants, photos (pending ones with a 10-minute preview link), publish blockers and its ETag" })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async product(@Param("id") id: string, @Res({ passthrough: true }) res: Response) {
    const view = await loadProduct(db(), uuidParam(id))
    return send(res, { data: view }, view.etag)
  }

  @Patch("products/:id")
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Edit product fields. A live product needs catalogue.publish and a reason" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.productInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async update(@Param("id") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const id = uuidParam(rawId)
    const body = readJson(req.chaanavya.body, 32 * 1024)
    await updateProduct(db(), id, header(req), productFields(body, { creating: false }), changeOf(staff, req, optionalReason(body)))
    const view = await loadProduct(db(), id)
    return send(res, { data: view }, view.etag)
  }

  @Put("products/:id/variants")
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Save the whole variant matrix in one transaction (create, update, archive). Never changes stock" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.variantsInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async variants(@Param("id") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const id = uuidParam(rawId)
    const body = readJson(req.chaanavya.body, 60 * 1024)
    await saveVariants(db(), id, header(req), body, changeOf(staff, req, optionalReason(body)))
    const view = await loadProduct(db(), id)
    return send(res, { data: view }, view.etag)
  }

  @Post("products/:id/publish")
  @HttpCode(200)
  @Access.permission("catalogue.publish")
  @ApiOperation({ summary: "Publish a draft: every publish check must pass and every checklist item be confirmed" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.statusInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  publish(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return this.status("publish", id, staff, req, res)
  }

  @Post("products/:id/unpublish")
  @HttpCode(200)
  @Access.permission("catalogue.publish")
  @ApiOperation({ summary: "Take a live product off the shop (back to draft)" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.statusInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  unpublish(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return this.status("unpublish", id, staff, req, res)
  }

  @Post("products/:id/archive")
  @HttpCode(200)
  @Access.permission("catalogue.publish")
  @ApiOperation({ summary: "Archive a product (kept for order history, hidden everywhere)" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.statusInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  archive(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return this.status("archive", id, staff, req, res)
  }

  @Post("products/:id/restore")
  @HttpCode(200)
  @Access.permission("catalogue.publish")
  @ApiOperation({ summary: "Restore an archived product as a draft" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.statusInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  restore(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return this.status("restore", id, staff, req, res)
  }

  private async status(action: StatusAction, rawId: string, staff: StaffActor, req: ApiRequest, res: Response) {
    const id = uuidParam(rawId)
    const body = readJson(req.chaanavya.body)
    const reason = requireReason(body)
    await changeStatus(db(), id, header(req), action, body, { ...changeOf(staff, req, reason), reason })
    const view = await loadProduct(db(), id)
    return send(res, { data: view }, view.etag)
  }

  // ---- photos ----

  @Post("products/:id/media/uploads")
  @HttpCode(201)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Ask to upload one photo: returns a 10-minute signed PUT to private staging for exactly this type, size and SHA-256" })
  @ApiBody({ schema: CatalogueSchemas.uploadInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.uploadIntent) })
  async upload(@Param("id") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const intent = await createUpload(db(), uuidParam(rawId), uploadRequest(readJson(req.chaanavya.body)), changeOf(staff, req, null))
    return send(res, { data: intent })
  }

  @Post("media/uploads/:uploadId/complete")
  @HttpCode(200)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Verify an uploaded photo (size, checksum, real type, dimensions); it then waits for approval" })
  @ApiBody({ schema: CatalogueSchemas.mediaInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async complete(@Param("uploadId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = req.chaanavya.body.text ? readJson(req.chaanavya.body) : {}
    const mediaId = await completeUpload(db(), uuidParam(rawId), body, changeOf(staff, req, null))
    return this.productOfMedia(mediaId, res)
  }

  @Patch("media/:mediaId")
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Alt text or position of a photo. A live photo needs catalogue.publish and a reason" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.mediaInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async editMedia(@Param("mediaId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const mediaId = uuidParam(rawId)
    const body = readJson(req.chaanavya.body)
    await updateMedia(db(), mediaId, header(req), body, changeOf(staff, req, optionalReason(body)))
    return this.productOfMedia(mediaId, res)
  }

  @Delete("media/:mediaId")
  @HttpCode(200)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Remove a photo from the product (files deleted after 7 days). A live photo needs catalogue.publish and a reason" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.mediaInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async deleteMedia(@Param("mediaId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const mediaId = uuidParam(rawId)
    const body = req.chaanavya.body.text ? readJson(req.chaanavya.body) : {}
    const productId = await this.productIdOf(mediaId)
    await removeMedia(db(), mediaId, header(req), changeOf(staff, req, optionalReason(body)))
    const view = await loadProduct(db(), productId)
    return send(res, { data: view }, view.etag)
  }

  @Post("media/:mediaId/approve")
  @HttpCode(200)
  @Access.permission("catalogue.publish")
  @ApiOperation({ summary: "Approve a pending photo: copied to public storage, staging copy deleted" })
  @ApiHeader(ifMatch)
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async approve(@Param("mediaId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const mediaId = uuidParam(rawId)
    const body = req.chaanavya.body.text ? readJson(req.chaanavya.body) : {}
    await approveMedia(db(), mediaId, header(req), changeOf(staff, req, optionalReason(body)))
    return this.productOfMedia(mediaId, res)
  }

  @Post("media/:mediaId/reject")
  @HttpCode(200)
  @Access.permission("catalogue.publish")
  @ApiOperation({ summary: "Reject a pending photo (needs a reason); its file is deleted" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: CatalogueSchemas.statusInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.product) })
  async reject(@Param("mediaId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const mediaId = uuidParam(rawId)
    const reason = requireReason(readJson(req.chaanavya.body))
    await rejectMedia(db(), mediaId, header(req), { ...changeOf(staff, req, reason), reason })
    return this.productOfMedia(mediaId, res)
  }

  private async productIdOf(mediaId: string) {
    const media = await db().productMedia.findUnique({ where: { id: mediaId }, select: { productId: true } })
    if (!media) throw new ApiError(404, "not_found", "not found")
    return media.productId
  }

  private async productOfMedia(mediaId: string, res: Response) {
    const view = await loadProduct(db(), await this.productIdOf(mediaId))
    return send(res, { data: view }, view.etag)
  }

  // ---- collections ----

  @Get("collections")
  @Access.permission("catalogue.read")
  @ApiOperation({ summary: "Every collection, storefront categories first" })
  @ApiOkResponse({ schema: data({ type: "array", items: CatalogueSchemas.collection }) })
  async collections(@Res({ passthrough: true }) res: Response) {
    return send(res, { data: await listCollections(db()) })
  }

  @Post("collections")
  @HttpCode(201)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Create a collection (hidden unless created by staff who may publish)" })
  @ApiBody({ schema: CatalogueSchemas.collectionInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.collection) })
  async createCollection(@CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body)
    const id = await createCollection(db(), collectionFields(body, { creating: true }), changeOf(staff, req, optionalReason(body)))
    const view = await loadCollection(db(), id)
    return send(res, { data: view }, view.etag)
  }

  @Patch("collections/:id")
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Edit a collection. Storefront categories keep their handle; showing or hiding needs catalogue.publish and a reason" })
  @ApiHeader({ name: "If-Match", required: true, description: "The collection's ETag" })
  @ApiBody({ schema: CatalogueSchemas.collectionInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.collection) })
  async updateCollection(@Param("id") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const id = uuidParam(rawId)
    const body = readJson(req.chaanavya.body)
    await updateCollection(db(), id, header(req), collectionFields(body, { creating: false }), changeOf(staff, req, optionalReason(body)))
    const view = await loadCollection(db(), id)
    return send(res, { data: view }, view.etag)
  }

  // ---- import and export ----

  @Post("import/preview")
  @HttpCode(200)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Check a catalogue CSV and list every error and planned change; writes nothing" })
  @ApiBody({ schema: CatalogueSchemas.importInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.importPreview) })
  async importPreview(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const csv = this.csvOf(req)
    const plan = await planImport(db(), csv.text)
    return send(res, { data: { errors: plan.errors, products: plan.products, summary: summaryOf(plan), token: plan.token } })
  }

  @Post("import/commit")
  @HttpCode(200)
  @Access.permission("catalogue.write")
  @ApiOperation({ summary: "Apply a previewed CSV with its token and a reason, all or nothing" })
  @ApiBody({ schema: CatalogueSchemas.importInput })
  @ApiOkResponse({ schema: data(CatalogueSchemas.importResult) })
  async importCommit(@CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const { text, body } = this.csvOf(req)
    if (typeof body.token !== "string" || !body.token) throw new ApiError(400, "invalid_request", "preview the file first and send its token", { token: "required" })
    const reason = requireReason(body)
    const summary = await commitImport(db(), text, body.token, { ...changeOf(staff, req, reason), reason })
    return send(res, { data: summary })
  }

  private csvOf(req: ApiRequest) {
    const body = readJson(req.chaanavya.body, 3 * 1024 * 1024)
    if (typeof body.csv !== "string") throw new ApiError(400, "invalid_request", "send the file as csv", { csv: "required" })
    if (Buffer.byteLength(body.csv) > IMPORT_MAX_BYTES) throw new ApiError(413, "invalid_request", "the file is larger than 1 MB")
    return { text: body.csv, body }
  }

  @Get("export")
  @Access.permission("catalogue.read")
  @ApiOperation({ summary: "Every product that is not archived as CSV, in the import format" })
  @ApiOkResponse({ content: { "text/csv": { schema: { type: "string" } } } })
  async export(@Res({ passthrough: true }) res: Response) {
    const csv = await exportCatalogue(db())
    res.setHeader("cache-control", "no-store")
    res.setHeader("content-type", "text/csv; charset=utf-8")
    res.setHeader("content-disposition", `attachment; filename="chaanavya-catalogue-${new Date().toISOString().slice(0, 10)}.csv"`)
    return csv
  }
}
