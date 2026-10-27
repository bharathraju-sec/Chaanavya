// The contact step for the shopper's bag (Stage 12.04): email and delivery address, no account
// needed. Rules in apps/api/src/checkout/contact.ts. Registered before CartController so that
// /cart/contact is not read as a cart id.
import { Controller, Get, Put, Req, Res } from "@nestjs/common"
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { readJson } from "../admin/api.ts"
import { readContact, saveContact } from "../checkout/contact.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { ownerFor } from "./cart.controller.ts"

const text = { type: "string" }
const optional = { type: ["string", "null"] }
const address = {
  type: "object",
  properties: { name: text, phone: { ...text, description: "Indian mobile, the delivery phone; stored as +91XXXXXXXXXX" }, line1: text, line2: optional, landmark: optional, city: text, district: text, stateCode: { ...text, description: "ISO 3166-2:IN, for example IN-KA" }, pinCode: { ...text, pattern: "^[1-9][0-9]{5}$" }, country: { type: "string", enum: ["IN"] } },
  required: ["name", "phone", "line1", "line2", "landmark", "city", "district", "stateCode", "pinCode", "country"],
  additionalProperties: false,
}
const contact = {
  type: "object",
  properties: { email: text, shippingAddress: address, marketing: { type: "string", enum: ["not_offered"] }, updatedAt: { type: "string", format: "date-time" } },
  required: ["email", "shippingAddress", "marketing", "updatedAt"],
  additionalProperties: false,
}

@ApiTags("cart")
@Controller("api/v1/cart/contact")
export class ContactController {
  @Get()
  @Access.shopper()
  @ApiOperation({ summary: "The contact details saved for the shopper's bag, or null" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: { oneOf: [contact, { type: "null" }] } }, required: ["data"], additionalProperties: false } })
  async read(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await readContact(db(), await ownerFor(req, res, { start: false })) }
  }

  @Put()
  @Access.shopper()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Save the email and delivery address for the shopper's bag; a guest needs no account. Places no order" })
  @ApiBody({ schema: { type: "object", properties: { email: text, shippingAddress: { ...address, required: ["name", "phone", "line1", "city", "district", "stateCode", "pinCode"] }, marketingConsent: { type: "boolean", description: "Not offered yet: only false or absent is accepted" } }, required: ["shippingAddress"] } })
  @ApiOkResponse({ schema: { type: "object", properties: { data: contact }, required: ["data"], additionalProperties: false } })
  async save(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const body = readJson(req.chaanavya.body)
    return { data: await saveContact(db(), await ownerFor(req, res, { start: false }), body) }
  }
}
