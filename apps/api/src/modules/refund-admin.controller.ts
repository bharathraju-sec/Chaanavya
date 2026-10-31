// Staff refunds (Stage 14.16). POST /api/v1/admin/payments/:attemptId/refunds refunds part or all of a captured
// payment: refunds.approve and a two-factor staff session (@Access.permission), on the admin host only; an
// Idempotency-Key is required, and the amount must be within the approver's limit and the refundable balance
// Razorpay itself reports. Sandbox only: the route does not exist in production until payments do. There is no
// storefront route and no admin page for it yet. Rules in apps/api/src/payments/refund.ts.
import { Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { ApiError, readJson } from "../admin/api.ts"
import type { StaffActor } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { paymentAdapterFor } from "../integrations/payments.ts"
import { orderIntentOpen } from "../orders/intent.ts"
import { parseRefundRequest, requestRefund } from "../payments/refund.ts"

const refundSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    paymentAttemptId: { type: "string", format: "uuid" },
    amount: { type: "object", properties: { amountPaise: { type: "integer", minimum: 100 }, currency: { type: "string", enum: ["INR"] } }, required: ["amountPaise", "currency"], additionalProperties: false },
    status: { type: "string", enum: ["requested", "processing", "succeeded", "failed", "rejected"] },
    providerRefundId: { type: ["string", "null"] },
    reason: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "paymentAttemptId", "amount", "status", "providerRefundId", "reason", "createdAt"],
  additionalProperties: false,
}

@ApiTags("payments admin")
@Controller("api/v1/admin/payments")
export class RefundAdminController {
  @Post(":attemptId/refunds")
  @HttpCode(200)
  @Access.permission("refunds.approve")
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary:
      "Refund part or all of a captured payment (sandbox). Needs refunds.approve and a two-factor session; the amount must be within the approver's limit (ADMIN up to ₹5,000) and what is still refundable by the provider's own record. The same Idempotency-Key returns the same refund; a refund whose outcome was lost is resumed by retrying with it",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true, description: "8 to 100 letters, digits, - or _: one per refund" })
  @ApiBody({ schema: { type: "object", properties: { amountPaise: { type: "integer", minimum: 100 }, reason: { type: "string", minLength: 3, maxLength: 500 } }, required: ["amountPaise", "reason"], additionalProperties: false } })
  @ApiOkResponse({ schema: { type: "object", properties: { data: refundSchema, created: { type: "boolean" } }, required: ["data", "created"], additionalProperties: false } })
  async refund(@Param("attemptId") attemptId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    const adapter = paymentAdapterFor(process.env)
    if (!adapter) throw new ApiError(503, "unavailable", "payments are not available right now")
    const input = parseRefundRequest(readJson(req.chaanavya.body, 2 * 1024))
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined
    const result = await requestRefund(db(), adapter, staff, attemptId, key, input, req.chaanavya.correlationId)
    return { data: result.refund, created: result.created }
  }
}
