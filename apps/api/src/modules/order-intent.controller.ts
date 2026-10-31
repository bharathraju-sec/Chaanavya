// Order intent (Stage 13.02): turn the shopper's checked quote into one pending order. Rules in
// apps/api/src/orders/intent.ts. Registered before CartController so that /cart/order is not read as
// a cart id. Development and staging only until payments exist. GET /cart/order/:orderId continues a
// pending order for the shopper who placed it (Stage 13.03, apps/api/src/orders/checkout-session.ts).
// POST /cart/order/:orderId/cancel lets that shopper cancel it before paying (Stage 13.09,
// apps/api/src/orders/cancel.ts; since 14.13 an opened checkout is first closed by what the provider says,
// apps/api/src/payments/close-attempt.ts). POST /cart/order/:orderId/payment opens the payment provider's sandbox
// checkout for it, for the saved order's total only (Stage 14.04, apps/api/src/payments/start.ts).
// POST /cart/order/:orderId/payment/return takes the browser's report from that checkout as an untrusted
// signal: read and checked, never recorded, never marking the order paid (Stage 14.07,
// apps/api/src/payments/checkout-return.ts).
import { Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags, type ApiResponseSchemaHost } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { readEnv } from "@chaanavya/shared/config/env"
import { PaymentAdapterError } from "@chaanavya/contracts/integrations/payment-gateway"
import { ApiError, readJson } from "../admin/api.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { paymentAdapterFor } from "../integrations/payments.ts"
import { pendingOrderFor } from "../orders/checkout-session.ts"
import { intentKeyOf, orderIntentOpen, placeOrderIntent } from "../orders/intent.ts"
import { receiveCheckoutReturn } from "../payments/checkout-return.ts"
import { shopperCancelsWithPayment } from "../payments/close-attempt.ts"
import { startPayment } from "../payments/start.ts"
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

const paymentSession: ApiResponseSchemaHost["schema"] = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        attemptId: { type: "string", format: "uuid" },
        provider: text,
        providerOrderId: text,
        amount: money,
        next: {
          oneOf: [
            { type: "object", properties: { kind: { type: "string", enum: ["embedded"] }, publicParams: { type: "object", additionalProperties: { type: "string" } } }, required: ["kind", "publicParams"], additionalProperties: false },
            { type: "object", properties: { kind: { type: "string", enum: ["redirect"] }, url: { type: "string", format: "uri" } }, required: ["kind", "url"], additionalProperties: false },
          ],
          description: "How the browser continues: open the provider's checkout on our page, or go to the provider's page. Public values only",
        },
      },
      required: ["attemptId", "provider", "providerOrderId", "amount", "next"],
      additionalProperties: false,
    },
    reused: { type: "boolean", description: "The attempt or its checkout already existed (a retry or another tab)" },
  },
  required: ["data", "reused"],
  additionalProperties: false,
}

const checkoutReturn: ApiResponseSchemaHost["schema"] = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        orderId: { type: "string", format: "uuid" },
        orderStatus: text,
        paymentStatus: text,
        outcome: { type: "string", enum: ["paid", "confirming", "not_paid"], description: "From our records only: paid once the provider has confirmed it, never because the browser said so" },
        verified: { type: "boolean", enum: [true], description: "The provider signed this return for the checkout we opened (an unsigned or tampered return is a 400)" },
      },
      required: ["orderId", "orderStatus", "paymentStatus", "outcome", "verified"],
      additionalProperties: false,
    },
  },
  required: ["data"],
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
  @ApiOperation({ summary: "Cancel the shopper's own unpaid order and release its stock, once. Repeating is harmless. An opened checkout is first closed by what the payment provider says (only failed tries: failed; no payment: expired). An order whose payment is captured, authorized or still in progress is left pending (awaiting_payment_outcome); another shopper's order is 404; 502 when the provider cannot be asked" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: placed, outcome: { type: "string", enum: ["cancelled", "awaiting_payment_outcome", "noop"] } }, required: ["data", "outcome"], additionalProperties: false } })
  async cancel(@Param("orderId") orderId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    let result
    try {
      result = await shopperCancelsWithPayment(db(), paymentAdapterFor(process.env), await ownerFor(req, res, { start: false }), orderId, req.chaanavya.correlationId)
    } catch (error) {
      // Razorpay could not say whether money is on its way: nothing is cancelled; try again shortly.
      if (error instanceof PaymentAdapterError) throw new ApiError(502, "unavailable", "the payment provider could not be checked; try again")
      throw error
    }
    return { data: result.order, outcome: result.outcome }
  }

  @Post(":orderId/payment")
  @HttpCode(200)
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      "Open the payment provider's checkout for the shopper's own pending order, for the saved order total in paise. Nothing in the request body is read: the browser cannot set the amount. The same Idempotency-Key, another tab or a retry returns the same attempt and checkout. Sandbox only; 503 when payments are off",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true, description: "8 to 100 letters, digits, - or _" })
  @ApiOkResponse({ schema: paymentSession })
  async payment(@Param("orderId") orderId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    const key = intentKeyOf(req.headers["idempotency-key"])
    const adapter = paymentAdapterFor(process.env)
    if (!adapter) throw new ApiError(503, "unavailable", "payments are not available right now")
    const result = await startPayment(db(), adapter, await ownerFor(req, res, { start: false }), orderId, key, { webUrl: readEnv(process.env, "WEB_URL") ?? "http://localhost:3000" })
    return { data: result.session, reused: result.reused }
  }

  @Post(":orderId/payment/return")
  @HttpCode(200)
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary:
      "Report what the payment provider's checkout handed the browser. An untrusted signal: its shape and the provider's signature are checked against the checkout we opened (a tampered return is a 400), nothing is recorded, and the order is never marked paid by it. The answer is our own record of the order and its payment",
  })
  @ApiBody({ schema: { type: "object", additionalProperties: { type: "string", maxLength: 256 }, maxProperties: 8, description: "The provider's fields as its checkout gave them (Razorpay: razorpay_payment_id, razorpay_order_id, razorpay_signature)" } })
  @ApiOkResponse({ schema: checkoutReturn })
  async paymentReturn(@Param("orderId") orderId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    const adapter = paymentAdapterFor(process.env)
    if (!adapter) throw new ApiError(503, "unavailable", "payments are not available right now")
    const view = await receiveCheckoutReturn(db(), adapter, await ownerFor(req, res, { start: false }), orderId, readJson(req.chaanavya.body, 2 * 1024))
    return { data: view }
  }
}
