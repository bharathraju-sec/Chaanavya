// Payment provider webhooks (Stage 14.09). POST /api/v1/webhooks/razorpay is called by Razorpay through the
// web host's forwarder (/api/webhooks/razorpay), which passes the body's bytes and Razorpay's signature
// headers through unchanged. Rules in apps/api/src/payments/webhook.ts: the signature over the raw bytes,
// the event id and the event are verified before anything is believed. Sandbox only, like the rest of
// payments: the route does not exist in production until payments do.
import { Controller, HttpCode, Post, Req, Res } from "@nestjs/common"
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { ApiError } from "../admin/api.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { paymentAdapterFor } from "../integrations/payments.ts"
import { orderIntentOpen } from "../orders/intent.ts"
import { receiveWebhook } from "../payments/webhook.ts"

@ApiTags("webhooks")
@Controller("api/v1/webhooks")
export class WebhooksController {
  @Post("razorpay")
  @HttpCode(200)
  @Access.webhook()
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @ApiOperation({
    summary:
      "Razorpay's webhook. Verified before anything is read: the signature over the exact raw body with the webhook secret, the event id, then the event type and its entity (INR only). Anything that does not verify is a 400. Each event is kept once in the inbox before it is acknowledged; a duplicate changes nothing. Sandbox only; not yet acted on",
  })
  @ApiHeader({ name: "X-Razorpay-Signature", required: true, description: "Hex HMAC-SHA256 of the raw body with the webhook secret" })
  @ApiHeader({ name: "X-Razorpay-Event-Id", required: true, description: "Razorpay's id for this event" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        received: { type: "boolean", enum: [true] },
        event: {
          oneOf: [
            { type: "null" },
            { type: "object", properties: { type: { type: "string" }, eventId: { type: "string" }, inbox: { type: "string", enum: ["stored", "duplicate", "conflict"], description: "Kept now, already kept (changes nothing), or a different body under a kept id (never stored over it)" } }, required: ["type", "eventId", "inbox"], additionalProperties: false },
          ],
          description: "The verified event, or null for a verified event we do not act on",
        },
      },
      required: ["received", "event"],
      additionalProperties: false,
    },
  })
  async razorpay(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!orderIntentOpen(process.env)) throw new ApiError(404, "not_found", "not found")
    const adapter = paymentAdapterFor(process.env)
    if (!adapter || adapter.provider !== "razorpay") throw new ApiError(503, "unavailable", "payments are not available right now")
    return receiveWebhook(db(), adapter, req.chaanavya.body, req.headers)
  }
}
