// Order recovery cases (Stage 13.14): stuck orders and stock holds found by the order reconciliation job,
// for a person to look at. Capabilities: orders.read to list (all staff), orders.manage to resolve with a
// reason (ADMIN, OWNER). Resolving closes the case only; it never changes the order, a payment or stock.
// See apps/api/src/orders/recovery.ts.
import { Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { ApiError, decodeCursor, oneOf, parsePage, readJson, requireReason, UUID, uuidParam } from "../admin/api.ts"
import type { StaffActor } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import { queryOf, type ApiRequest } from "../http/context.ts"
import { data, list, OrderAdminSchemas } from "../http/schemas.ts"
import { CASE_KINDS, CASE_STATUSES, isCaseCursor, listCases, resolveCase } from "../orders/recovery.ts"

function send(res: Response, body: unknown) {
  res.setHeader("cache-control", "no-store")
  return body
}

@ApiTags("orders admin")
@Controller("api/v1/admin/order-recovery")
export class OrderRecoveryController {
  @Get("cases")
  @Access.permission("orders.read")
  @ApiOperation({ summary: "Recovery cases for stuck orders and stock holds, newest first; open cases unless a status is given" })
  @ApiQuery({ name: "status", required: false, enum: [...CASE_STATUSES] })
  @ApiQuery({ name: "kind", required: false, enum: [...CASE_KINDS] })
  @ApiQuery({ name: "orderId", required: false })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(OrderAdminSchemas.recoveryCase) })
  async list(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query, { defaultLimit: 50 })
    const status = oneOf(query.get("status") ?? "open", CASE_STATUSES, "status")
    const kind = query.get("kind") === null ? null : oneOf(query.get("kind"), CASE_KINDS, "kind")
    const orderId = query.get("orderId")
    if (orderId !== null && !UUID.test(orderId)) throw new ApiError(400, "invalid_request", "orderId must be an order id", { orderId: "invalid" })
    const { items, nextCursor } = await listCases(db(), { status, kind, orderId }, { limit, after: decodeCursor(cursor, isCaseCursor) })
    return send(res, { data: items, page: { nextCursor } })
  }

  @Post("cases/:caseId/resolve")
  @HttpCode(200)
  @Access.permission("orders.manage")
  @ApiOperation({ summary: "Close an open recovery case with a reason; changes nothing on the order (a closed case is 409)" })
  @ApiBody({ schema: OrderAdminSchemas.holdInput })
  @ApiOkResponse({ schema: data(OrderAdminSchemas.recoveryCase) })
  async resolve(@Param("caseId") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const reason = requireReason(readJson(req.chaanavya.body))
    return send(res, { data: await resolveCase(db(), uuidParam(id), reason, staff, req.chaanavya.correlationId) })
  }
}
