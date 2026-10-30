// Order intent (Stage 13.02): turn the shopper's checked quote into one pending order. Rules in
// apps/api/src/orders/intent.ts. Registered before CartController so that /cart/order is not read as
// a cart id. Development and staging only until payments exist. GET /cart/order/:orderId continues a
// pending order for the shopper who placed it (Stage 13.03, apps/api/src/orders/checkout-session.ts).
// POST /cart/order/:orderId/cancel lets that shopper cancel it before paying (Stage 13.09,
// apps/api/src/orders/cancel.ts).
import { Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { ApiError, readJson } from "../admin/api.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { shopperCancelsOrder } from "../orders/cancel.ts"
import { pendingOrderFor } from "../orders/checkout-session.ts"
import { intentKeyOf, orderIntentOpen, placeOrderIntent } from "../orders/intent.ts"
import { ownerFor } from "./cart.controller.ts"

const text = { type: "string" }
const money = { type: "object", properties: { amountPaise: { type: "integer", minimum: 0 }, currency: { type: "string", enum: ["INR"] } }, required: ["amountPaise", "currency"], additionalProperties: false }
const placed = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    number: { type: "string", pattern: "^CHV-[0-9]{6,}$" },
    status: text,
    quoteId: { type: "string", format: "uuid" },
    grandTotal: money,
    test: { type: "boolean", description: "Priced with sandbox delivery rates or a draft tax profile: never a real sale" },
    payableUntil: { type: "string", format: "date-time", description: "The quote's expiry: after it, ask for a new quote" },
    items: {
      type: "array",
      items: { type: "object", properties: { sku: text, productTitle: text, variantTitle: text, quantity: { type: "integer" }, lineTotal: money }, required: ["sku", "productTitle", "variantTitle", "quantity", "lineTotal"], additionalProperties: false },
    },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "number", "status", "quoteId", "grandTotal", "test", "payableUntil", "items", "createdAt"],
  additionalProperties: false,
}

@ApiTags("cart")
@Controller("api/v1/cart/order")
export class OrderIntentController {
  @Post()
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Place one pending order from the shopper's checked quote. The same Idempotency-Key, or the same quote again, returns the original order (200); a new order is 201. Takes no payment" })
  @ApiHeader({ name: "Idempotency-Key", required: true, description: "8 to 100 letters, digits, - or _; one per order attempt" })
  @ApiBody({ schema: { type: "object", properties: { quoteId: { type: "string", format: "uuid" }, expectedGrandTotal: money }, required: ["quoteId", "expectedGrandTotal"] } })
  @ApiOkResponse({ description: "The original order, for a repeated submission", schema: { type: "object", properties: { data: placed, replayed: { type: "boolean" } }, required: ["data", "replayed"], additionalProperties: false } })
  async place(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const key = intentKeyOf(req.headers["idempotency-key"])
    const result = await placeOrderIntent(db(), await ownerFor(req, res, { start: false }), key, readJson(req.chaanavya.body), { correlationId: req.chaanavya.correlationId })
    res.status(result.created ? 201 : 200)
    return { data: result.order, replayed: !result.created }
  }

  @Get(":orderId")
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "The shopper's own pending order, to continue its checkout. Any order that is not theirs is the same 404 as an unknown one; an expired, ended or no longer pending checkout is 409" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: placed }, required: ["data"], additionalProperties: false } })
  async pending(@Param("orderId") orderId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    return { data: await pendingOrderFor(db(), await ownerFor(req, res, { start: false }), orderId) }
  }

  @Post(":orderId/cancel")
  @HttpCode(200)
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Cancel the shopper's own unpaid order and release its stock, once. Repeating is harmless. An order whose payment is still in flight is left pending (awaiting_payment_outcome); another shopper's order is 404" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: placed, outcome: { type: "string", enum: ["cancelled", "awaiting_payment_outcome", "noop"] } }, required: ["data", "outcome"], additionalProperties: false } })
  async cancel(@Param("orderId") orderId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    const result = await shopperCancelsOrder(db(), await ownerFor(req, res, { start: false }), orderId, req.chaanavya.correlationId)
    return { data: result.order, outcome: result.outcome }
  }
}
