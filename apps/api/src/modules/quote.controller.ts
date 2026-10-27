// The checkout quote for the shopper's bag (Stage 12.09). Rules in apps/api/src/checkout/quote.ts.
// Registered before CartController so that /cart/quote is not read as a cart id.
import { Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { readJson } from "../admin/api.ts"
import { checkQuote, quoteBag } from "../checkout/quote.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { ownerFor } from "./cart.controller.ts"

const text = { type: "string" }
const money = { type: "object", properties: { amountPaise: { type: "integer", minimum: 0 }, currency: { type: "string", enum: ["INR"] } }, required: ["amountPaise", "currency"], additionalProperties: false }
const taxLine = {
  type: "object",
  properties: { component: { type: "string", enum: ["CGST", "SGST", "UTGST", "IGST"] }, rateBasisPoints: { type: "number" }, amount: money },
  required: ["component", "rateBasisPoints", "amount"],
  additionalProperties: false,
}
const classification = {
  type: "object",
  properties: {
    taxProfileId: text,
    profileApproved: { type: "boolean" },
    taxCategory: text,
    hsnCode: text,
    rateBasisPoints: { type: "integer" },
    supply: { type: "string", enum: ["intra", "inter"] },
    sellerStateCode: text,
    deliveryStateCode: text,
    pricesIncludeTax: { type: "boolean" },
    rounding: { type: "string", enum: ["line_half_up_v1"] },
  },
  required: ["taxProfileId", "profileApproved", "taxCategory", "hsnCode", "rateBasisPoints", "supply", "sellerStateCode", "deliveryStateCode", "pricesIncludeTax", "rounding"],
  additionalProperties: false,
}
const line = {
  type: "object",
  properties: {
    variantId: text,
    sku: text,
    title: text,
    variantTitle: text,
    quantity: { type: "integer", minimum: 1 },
    unitPrice: money,
    lineSubtotal: money,
    discount: money,
    tax: { type: "array", items: taxLine },
    lineTotal: money,
    classification,
  },
  required: ["variantId", "sku", "title", "variantTitle", "quantity", "unitPrice", "lineSubtotal", "discount", "tax", "lineTotal", "classification"],
  additionalProperties: false,
}
const quote = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    id: { type: "string", format: "uuid" },
    cartId: { type: "string", format: "uuid" },
    cartRevision: { type: "integer" },
    lines: { type: "array", items: line },
    promotionId: { type: ["string", "null"] },
    subtotal: money,
    discountTotal: money,
    shippingFee: money,
    taxTotal: money,
    grandTotal: money,
    pricesIncludeTax: { type: "boolean" },
    courierQuoteRef: { type: ["string", "null"] },
    expiresAt: { type: "string", format: "date-time" },
    shipping: {
      type: "object",
      properties: { serviceRef: text, courierName: text, mode: { type: "string", enum: ["air", "surface"] }, estimatedDeliveryDays: { type: ["integer", "null"] }, fee: money, tax: { type: "array", items: taxLine }, total: money },
      required: ["serviceRef", "courierName", "mode", "estimatedDeliveryDays", "fee", "tax", "total"],
      additionalProperties: false,
    },
    supply: { type: "string", enum: ["intra", "inter"] },
    mode: { type: "string", enum: ["test", "live"], description: "test: sandbox delivery rates or an unapproved tax profile; never a real order" },
    testReasons: { type: "array", items: { type: "string", enum: ["test_shipping_rates", "tax_profile_unapproved"] } },
  },
  required: ["version", "id", "cartId", "cartRevision", "lines", "promotionId", "subtotal", "discountTotal", "shippingFee", "taxTotal", "grandTotal", "pricesIncludeTax", "courierQuoteRef", "expiresAt", "shipping", "supply", "mode", "testReasons"],
  additionalProperties: false,
}

@ApiTags("cart")
@Controller("api/v1/cart/quote")
export class QuoteController {
  @Post()
  @HttpCode(200)
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Price the shopper's bag on the server: catalogue prices, promotion, delivery and GST. Any amount in the body is ignored. Places no order" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        serviceRef: { type: ["string", "null"], description: "A delivery option from /cart/shipping-rates; the cheapest when absent" },
        cartRevision: { type: ["integer", "null"], description: "The bag revision the shopper reviewed; a stale one is refused" },
      },
    },
  })
  @ApiOkResponse({ schema: { type: "object", properties: { data: quote }, required: ["data"], additionalProperties: false } })
  async create(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await quoteBag(db(), await ownerFor(req, res, { start: false }), readJson(req.chaanavya.body)) }
  }

  @Get(":quoteId")
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Check the shopper's stored quote: 404 unless it is theirs and still the bag's latest; 409 once it has expired or anything it was priced from has changed (the quote is then discarded)" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: { type: "object", properties: { status: { type: "string", enum: ["valid"] }, quote }, required: ["status", "quote"], additionalProperties: false } }, required: ["data"], additionalProperties: false } })
  async check(@Param("quoteId") quoteId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await checkQuote(db(), await ownerFor(req, res, { start: false }), quoteId) }
  }
}
