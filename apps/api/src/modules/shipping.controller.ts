// Delivery and rates for the shopper's bag (Stage 12.08). Rules in apps/api/src/shipping/courier.ts.
// Registered before CartController so that /cart/shipping-rates is not read as a cart id.
import { Controller, Get, Req, Res } from "@nestjs/common"
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { courierFor, shippingRatesFor } from "../shipping/courier.ts"
import { ownerFor } from "./cart.controller.ts"

const text = { type: "string" }
const restriction = { type: "string", enum: ["fragrance_liquid", "jewellery_high_value"] }
const option = {
  type: "object",
  properties: {
    serviceRef: text,
    courierName: text,
    rate: { type: "object", properties: { amountPaise: { type: "integer", minimum: 0 }, currency: { type: "string", enum: ["INR"] } }, required: ["amountPaise", "currency"], additionalProperties: false },
    estimatedDeliveryDays: { type: ["integer", "null"] },
    quotedAt: { type: "string", format: "date-time" },
    mode: { type: "string", enum: ["air", "surface"] },
    maxWeightGrams: { type: "integer" },
    maxDeclaredValuePaise: { type: ["integer", "null"] },
    acceptsRestrictions: { type: "array", items: restriction },
  },
  required: ["serviceRef", "courierName", "rate", "estimatedDeliveryDays", "quotedAt", "mode", "maxWeightGrams", "maxDeclaredValuePaise", "acceptsRestrictions"],
  additionalProperties: false,
}
const quote = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["available", "unavailable"] },
    reason: { type: "string", enum: ["pin_unserviceable", "category_restricted", "parcel_unsupported", "provider_unavailable"] },
    options: { type: "array", items: option },
    quotedAt: { type: "string", format: "date-time" },
    notCarried: { type: "array", items: restriction, description: "With category_restricted: the restrictions no offered service carries" },
  },
  required: ["status", "options", "quotedAt"],
  additionalProperties: false,
}
const rates = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["test", "live", "none"], description: "test: sandbox courier, simulated prices that must be shown as test rates; live: a connected courier; none: no courier here" },
    delivery: {
      type: "object",
      properties: { pinCode: text, format: { type: "string", enum: ["valid", "invalid"] }, delivery: { type: "string", enum: ["unknown", "serviceable", "not_serviceable"] }, deliverable: { type: "boolean" }, source: { type: "string", enum: ["none", "test", "live"] } },
      required: ["pinCode", "format", "delivery", "deliverable", "source"],
      additionalProperties: false,
    },
    quote: { oneOf: [quote, { type: "null" }] },
    liveEligible: { type: "boolean", description: "True only for a live courier's answer; never for test rates" },
    restrictedItems: {
      type: "array",
      description: "The bag's items no offered service carries; empty otherwise",
      items: { type: "object", properties: { sku: text, title: text }, required: ["sku", "title"], additionalProperties: false },
    },
  },
  required: ["mode", "delivery", "quote", "liveEligible", "restrictedItems"],
  additionalProperties: false,
}

@ApiTags("cart")
@Controller("api/v1/cart/shipping-rates")
export class ShippingController {
  @Get()
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Delivery and courier rates for the shopper's bag to its saved delivery address. Test rates in development and staging; books nothing" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: rates }, required: ["data"], additionalProperties: false } })
  async read(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await shippingRatesFor(db(), await ownerFor(req, res, { start: false }), courierFor(process.env)) }
  }
}
