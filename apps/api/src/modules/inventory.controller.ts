// Inventory API (Stage 09): stock per SKU, movement history, receive / adjust / write off, low-stock
// thresholds, and stocktakes (count, import, submit, approve with a signed reconciliation report).
// Capabilities: inventory.read (all staff), inventory.adjust (ADMIN, OWNER), inventory.approve
// (OWNER). Changes need a reason and the record's ETag; an Idempotency-Key header makes a retry safe.
import { Controller, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { ApiError, decodeCursor, oneOf, parsePage, readJson, requireReason, uuidParam } from "../admin/api.ts"
import type { StaffActor } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import { queryOf, type ApiRequest } from "../http/context.ts"
import { data, InventorySchemas, list } from "../http/schemas.ts"
import { ADJUST_REASONS, adjust, listMovements, listStock, loadStock, receive, setThreshold, units, WRITE_OFF_REASONS, writeOff, type StaffChange } from "../inventory/stock.ts"
import { approveStocktake, cancelStocktake, createStocktake, IMPORT_SOURCES, importStocktake, lineInputs, listStocktakes, loadStocktake, setLines, submitStocktake, type StocktakeChange } from "../inventory/stocktakes.ts"

const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,100}$/
const ifMatchHeader = { name: "If-Match", required: true, description: "The record's ETag" }
const keyHeader = { name: "Idempotency-Key", required: false, description: "8 to 100 letters, digits, - or _: a retry with the same key changes nothing" }
const isSku = (v: unknown): v is { sku: string } => typeof (v as { sku?: unknown })?.sku === "string"
const isId = (v: unknown): v is { id: string } => typeof (v as { id?: unknown })?.id === "string"

const header = (req: ApiRequest, name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined)

function idempotencyKey(req: ApiRequest) {
  const key = header(req, "idempotency-key")
  if (key === undefined) return null
  if (!IDEMPOTENCY.test(key)) throw new ApiError(400, "invalid_request", "Idempotency-Key must be 8 to 100 letters, digits, - or _", { "Idempotency-Key": "invalid" })
  return key
}

const staffActor = (staff: StaffActor) => ({ kind: "staff" as const, id: staff.userId })
const stockChange = (staff: StaffActor, req: ApiRequest, reason: string): StaffChange => ({ actor: staffActor(staff), correlationId: req.chaanavya.correlationId, reason, idempotencyKey: idempotencyKey(req) })
const stocktakeChange = (staff: StaffActor, req: ApiRequest): StocktakeChange => ({ actor: staffActor(staff), correlationId: req.chaanavya.correlationId })

function send(res: Response, body: unknown, etag?: string) {
  res.setHeader("cache-control", "no-store")
  if (etag) res.setHeader("etag", etag)
  return body
}

@ApiTags("inventory admin")
@Controller("api/v1/admin/inventory")
export class InventoryController {
  // ---- stock ----

  @Get("stock")
  @Access.permission("inventory.read")
  @ApiOperation({ summary: "Stock per SKU (on hand, held, allocated, available), with SKU or product search, low-stock and never-counted filters" })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "lowStock", required: false, enum: ["1"] })
  @ApiQuery({ name: "uncounted", required: false, enum: ["1"] })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(InventorySchemas.stock) })
  async stock(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query, { defaultLimit: 50 })
    const { items, nextCursor } = await listStock(db(), { search: query.get("search")?.slice(0, 100) ?? null, lowStock: query.get("lowStock") === "1", uncounted: query.get("uncounted") === "1", limit, after: decodeCursor(cursor, isSku) })
    return send(res, { data: items, page: { nextCursor } })
  }

  @Get("stock/:variantId")
  @Access.permission("inventory.read")
  @ApiOperation({ summary: "One SKU's stock, with the ETag to send as If-Match" })
  @ApiOkResponse({ schema: data(InventorySchemas.stock) })
  async one(@Param("variantId") id: string, @Res({ passthrough: true }) res: Response) {
    const view = await loadStock(db(), uuidParam(id))
    return send(res, { data: view }, view.etag)
  }

  @Get("stock/:variantId/movements")
  @Access.permission("inventory.read")
  @ApiOperation({ summary: "The SKU's ledger, newest first: every receipt, correction, write-off, hold, release and allocation" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(InventorySchemas.movement) })
  async movements(@Param("variantId") id: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const { limit, cursor } = parsePage(queryOf(req), { defaultLimit: 50 })
    const variantId = uuidParam(id)
    await loadStock(db(), variantId)
    const { items, nextCursor } = await listMovements(db(), variantId, { limit, after: decodeCursor(cursor, isId) })
    return send(res, { data: items, page: { nextCursor } })
  }

  @Post("stock/:variantId/receive")
  @HttpCode(200)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Receive units into stock (needs a reason and If-Match)" })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(keyHeader)
  @ApiBody({ schema: InventorySchemas.quantityInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stock) })
  async receive(@Param("variantId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body)
    const view = await receive(db(), uuidParam(id), header(req, "if-match"), units(body.quantity), stockChange(staff, req, requireReason(body)))
    return send(res, { data: view }, view.etag)
  }

  @Post("stock/:variantId/adjust")
  @HttpCode(200)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Correct on-hand stock up or down with a reason code (found, damaged, lost, data_entry, other)" })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(keyHeader)
  @ApiBody({ schema: InventorySchemas.adjustInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stock) })
  async adjust(@Param("variantId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body)
    const view = await adjust(db(), uuidParam(id), header(req, "if-match"), units(body.delta, "delta", { signed: true }), oneOf(body.reasonCode, ADJUST_REASONS, "reasonCode"), stockChange(staff, req, requireReason(body)))
    return send(res, { data: view }, view.etag)
  }

  @Post("stock/:variantId/write-off")
  @HttpCode(200)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Write units off (damaged, lost, expired, sample, other)" })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(keyHeader)
  @ApiBody({ schema: InventorySchemas.writeOffInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stock) })
  async writeOff(@Param("variantId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body)
    const view = await writeOff(db(), uuidParam(id), header(req, "if-match"), units(body.quantity), oneOf(body.reasonCode, WRITE_OFF_REASONS, "reasonCode"), stockChange(staff, req, requireReason(body)))
    return send(res, { data: view }, view.etag)
  }

  @Patch("stock/:variantId")
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Set or clear the low-stock threshold" })
  @ApiHeader(ifMatchHeader)
  @ApiBody({ schema: InventorySchemas.thresholdInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stock) })
  async settings(@Param("variantId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body)
    const raw = body.lowStockThreshold
    const threshold = raw === null || raw === "" ? null : Number(raw)
    if (threshold !== null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100_000)) throw new ApiError(400, "invalid_request", "the threshold is 0 to 100000 units, or empty", { lowStockThreshold: "invalid" })
    const view = await setThreshold(db(), uuidParam(id), header(req, "if-match"), threshold, { actor: staffActor(staff), correlationId: req.chaanavya.correlationId, reason: null, idempotencyKey: null })
    return send(res, { data: view }, view.etag)
  }

  // ---- stocktakes ----

  @Get("stocktakes")
  @Access.permission("inventory.read")
  @ApiOperation({ summary: "Stocktakes, newest first" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(InventorySchemas.stocktakeListItem) })
  async stocktakes(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const { limit, cursor } = parsePage(queryOf(req))
    const { items, nextCursor } = await listStocktakes(db(), { limit, after: decodeCursor(cursor, isId) })
    return send(res, { data: items, page: { nextCursor } })
  }

  @Post("stocktakes")
  @HttpCode(201)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Start a stocktake (draft)" })
  @ApiBody({ schema: InventorySchemas.stocktakeInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async start(@CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = req.chaanavya.body.text ? readJson(req.chaanavya.body) : {}
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : ""
    const view = await loadStocktake(db(), await createStocktake(db(), note, stocktakeChange(staff, req)))
    return send(res, { data: view }, view.etag)
  }

  @Post("stocktakes/import")
  @HttpCode(200)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Turn a count file into a draft stocktake. The same file always returns the same stocktake. Shopify quantities are reference only" })
  @ApiBody({ schema: InventorySchemas.importInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async import(@CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body, 3 * 1024 * 1024)
    if (typeof body.csv !== "string" || Buffer.byteLength(body.csv) > 1024 * 1024) throw new ApiError(400, "invalid_request", "send the file as csv, up to 1 MB", { csv: "required" })
    const source = oneOf(body.source ?? "owner_csv", IMPORT_SOURCES, "source")
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : ""
    const { id, created } = await importStocktake(db(), body.csv, source, note, stocktakeChange(staff, req))
    const view = await loadStocktake(db(), id)
    res.setHeader("x-import-result", created ? "created" : "existing")
    return send(res, { data: view }, view.etag)
  }

  @Get("stocktakes/:id")
  @Access.permission("inventory.read")
  @ApiOperation({ summary: "A stocktake with its reconciliation report (as signed, once approved)" })
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async stocktake(@Param("id") id: string, @Res({ passthrough: true }) res: Response) {
    const view = await loadStocktake(db(), uuidParam(id))
    return send(res, { data: view }, view.etag)
  }

  @Put("stocktakes/:id/lines")
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Replace the counted lines of a draft" })
  @ApiHeader(ifMatchHeader)
  @ApiBody({ schema: InventorySchemas.linesInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async lines(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body, 3 * 1024 * 1024)
    const view = await setLines(db(), uuidParam(id), header(req, "if-match"), lineInputs(body.lines), stocktakeChange(staff, req))
    return send(res, { data: view }, view.etag)
  }

  @Post("stocktakes/:id/submit")
  @HttpCode(200)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Finish counting; the lines are frozen for approval" })
  @ApiHeader(ifMatchHeader)
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async submit(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const view = await submitStocktake(db(), uuidParam(id), header(req, "if-match"), stocktakeChange(staff, req))
    return send(res, { data: view }, view.etag)
  }

  @Post("stocktakes/:id/approve")
  @HttpCode(200)
  @Access.permission("inventory.approve")
  @ApiOperation({ summary: "Sign the reconciliation report: accept every discrepancy by SKU, confirm the statement, type your name. Corrections and last-counted dates commit together" })
  @ApiHeader(ifMatchHeader)
  @ApiBody({ schema: InventorySchemas.approveInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async approve(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const body = readJson(req.chaanavya.body, 256 * 1024)
    const accepted = Array.isArray(body.acceptedSkus) ? body.acceptedSkus.filter((s): s is string => typeof s === "string").map(s => s.trim().toUpperCase()) : []
    const view = await approveStocktake(
      db(),
      uuidParam(id),
      header(req, "if-match"),
      { signedName: typeof body.signedName === "string" ? body.signedName.slice(0, 120) : "", acceptedSkus: accepted, statement: body.statement === true, reason: requireReason(body) },
      stocktakeChange(staff, req),
    )
    return send(res, { data: view }, view.etag)
  }

  @Post("stocktakes/:id/cancel")
  @HttpCode(200)
  @Access.permission("inventory.adjust")
  @ApiOperation({ summary: "Cancel a draft or submitted stocktake (needs a reason)" })
  @ApiHeader(ifMatchHeader)
  @ApiBody({ schema: InventorySchemas.reasonInput })
  @ApiOkResponse({ schema: data(InventorySchemas.stocktake) })
  async cancel(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const view = await cancelStocktake(db(), uuidParam(id), header(req, "if-match"), requireReason(readJson(req.chaanavya.body)), stocktakeChange(staff, req))
    return send(res, { data: view }, view.etag)
  }
}
