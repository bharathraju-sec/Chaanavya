// Staff order reads (Stage 13.12): the order list with filters, one order, and the buyer's contact.
// Capabilities: orders.read for the list and the order (the buyer masked), customers.read for the full
// contact (POST, same-origin only, every read audited). Staff role and a two-factor session are checked by @Access.permission;
// customers and visitors are refused (401/403), and off the admin host these routes do not exist (404).
// Staff actions (Stage 13.13, orders.manage): hold, release and internal notes; hold and release need a
// reason and If-Match, notes an Idempotency-Key. See apps/api/src/orders/admin.ts and admin-actions.ts.
import { Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { ApiError, decodeCursor, parsePage, readJson, requireReason, uuidParam } from "../admin/api.ts"
import type { StaffActor } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import { queryOf, type ApiRequest } from "../http/context.ts"
import { data, list, OrderAdminSchemas } from "../http/schemas.ts"
import { contactFor, filtersOf, isOrderCursor, listOrders, loadOrder } from "../orders/admin.ts"
import { addNote, noteText, setHold, type OrderChange } from "../orders/admin-actions.ts"

const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,100}$/
const ifMatchHeader = { name: "If-Match", required: true, description: "The order's ETag" }
const keyHeader = (required: boolean) => ({ name: "Idempotency-Key", required, description: "8 to 100 letters, digits, - or _: a retry with the same key changes nothing" })

const header = (req: ApiRequest, name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined)

function change(staff: StaffActor, req: ApiRequest): OrderChange {
  const key = header(req, "idempotency-key")
  if (key !== undefined && !IDEMPOTENCY.test(key)) throw new ApiError(400, "invalid_request", "Idempotency-Key must be 8 to 100 letters, digits, - or _", { "Idempotency-Key": "invalid" })
  return { actorId: staff.userId, correlationId: req.chaanavya.correlationId, idempotencyKey: key ?? null }
}

function send(res: Response, body: unknown, etag?: string) {
  res.setHeader("cache-control", "no-store")
  if (etag) res.setHeader("etag", etag)
  return body
}

@ApiTags("orders admin")
@Controller("api/v1/admin/orders")
export class OrderAdminController {
  @Get()
  @Access.permission("orders.read")
  @ApiOperation({ summary: "Orders, newest first, with status, fulfilment, payment, date and order-number filters; buyers masked" })
  @ApiQuery({ name: "status", required: false, enum: ["pending_payment", "needs_review", "confirmed", "completed", "cancelled"] })
  @ApiQuery({ name: "fulfilmentStatus", required: false, enum: ["unfulfilled", "packing", "packed", "handed_over", "cancelled"] })
  @ApiQuery({ name: "paymentStatus", required: false, enum: ["created", "authorized", "captured", "pending_reconciliation", "failed", "expired", "partially_refunded", "refunded"] })
  @ApiQuery({ name: "placedFrom", required: false, description: "ISO date, inclusive" })
  @ApiQuery({ name: "placedTo", required: false, description: "ISO date, exclusive" })
  @ApiQuery({ name: "number", required: false, description: "An order number, for example CHV-1001" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(OrderAdminSchemas.listItem) })
  async list(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query, { defaultLimit: 50 })
    const filters = filtersOf(query)
    const { items, nextCursor } = await listOrders(db(), filters, { limit, after: decodeCursor(cursor, isOrderCursor) })
    return send(res, { data: items, page: { nextCursor } })
  }

  @Get(":orderId")
  @Access.permission("orders.read")
  @ApiOperation({ summary: "One order: items, totals, payments, stock hold, late-payment exceptions and its event trail; buyer masked" })
  @ApiOkResponse({ schema: data(OrderAdminSchemas.order) })
  async one(@Param("orderId") id: string, @Res({ passthrough: true }) res: Response) {
    const order = await loadOrder(db(), uuidParam(id))
    return send(res, { data: order }, order.etag)
  }

  // POST, not GET: a read that writes an audit record must pass the same-origin check (GETs skip it) and is
  // never prefetched or triggered by a link from another site.
  @Post(":orderId/contact")
  @HttpCode(200)
  @Access.permission("customers.read")
  @ApiOperation({ summary: "The buyer's full name, email, phone and addresses for one order; every read is audited (POST, same-origin only)" })
  @ApiOkResponse({ schema: data(OrderAdminSchemas.contact) })
  async contact(@Param("orderId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return send(res, { data: await contactFor(db(), uuidParam(id), staff, req.chaanavya.correlationId) })
  }

  @Post(":orderId/hold")
  @HttpCode(200)
  @Access.permission("orders.manage")
  @ApiOperation({ summary: "Put an open order on hold: fulfilment cannot move forward until released (needs a reason and If-Match)" })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(keyHeader(false))
  @ApiBody({ schema: OrderAdminSchemas.holdInput })
  @ApiOkResponse({ schema: data(OrderAdminSchemas.hold) })
  async hold(@Param("orderId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const reason = requireReason(readJson(req.chaanavya.body))
    const view = await setHold(db(), uuidParam(id), header(req, "if-match"), true, reason, change(staff, req))
    return send(res, { data: view }, view.etag)
  }

  @Post(":orderId/release")
  @HttpCode(200)
  @Access.permission("orders.manage")
  @ApiOperation({ summary: "Release an order's hold (needs a reason and If-Match)" })
  @ApiHeader(ifMatchHeader)
  @ApiHeader(keyHeader(false))
  @ApiBody({ schema: OrderAdminSchemas.holdInput })
  @ApiOkResponse({ schema: data(OrderAdminSchemas.hold) })
  async release(@Param("orderId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const reason = requireReason(readJson(req.chaanavya.body))
    const view = await setHold(db(), uuidParam(id), header(req, "if-match"), false, reason, change(staff, req))
    return send(res, { data: view }, view.etag)
  }

  @Post(":orderId/notes")
  @HttpCode(201)
  @Access.permission("orders.manage")
  @ApiOperation({ summary: "Add an internal note to an order; never shown to the buyer (needs an Idempotency-Key)" })
  @ApiHeader(keyHeader(true))
  @ApiBody({ schema: OrderAdminSchemas.noteInput })
  @ApiOkResponse({ schema: data(OrderAdminSchemas.note) })
  async note(@Param("orderId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const text = noteText(readJson(req.chaanavya.body).text)
    return send(res, { data: await addNote(db(), uuidParam(id), text, change(staff, req)) })
  }
}
