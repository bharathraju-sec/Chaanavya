// A signed-in customer's saved addresses (Stage 12.03). The rules live in
// apps/api/src/checkout/address-book.ts: own addresses only (anything else is 404 not_found),
// verified email required, every address checked on the server, one default.
import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { readJson } from "../admin/api.ts"
import type { SignedIn } from "../auth/session.ts"
import { createAddress, deleteAddress, listAddresses, setDefaultAddress, updateAddress } from "../checkout/address-book.ts"
import { db } from "../db/client.ts"
import { Access, CurrentCustomer } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"

const text = { type: "string" }
const optional = { type: "string", nullable: true }
const address = {
  type: "object",
  properties: { name: text, phone: { ...text, description: "Indian mobile, stored as +91XXXXXXXXXX" }, line1: text, line2: optional, landmark: optional, city: text, district: text, stateCode: { ...text, description: "ISO 3166-2:IN, for example IN-KA" }, pinCode: { ...text, pattern: "^[1-9][0-9]{5}$" }, country: { type: "string", enum: ["IN"] } },
  required: ["name", "phone", "line1", "line2", "landmark", "city", "district", "stateCode", "pinCode", "country"],
  additionalProperties: false,
}
const saved = {
  type: "object",
  properties: { version: { type: "integer", enum: [1] }, id: { type: "string", format: "uuid" }, address, isDefault: { type: "boolean" }, updatedAt: { type: "string", format: "date-time" } },
  required: ["version", "id", "address", "isDefault", "updatedAt"],
  additionalProperties: false,
}
const one = { type: "object", properties: { data: saved }, required: ["data"], additionalProperties: false }
const input = { ...address, required: ["name", "phone", "line1", "city", "district", "stateCode", "pinCode"] }

@ApiTags("account")
@Controller("api/v1/account/addresses")
export class AddressController {
  @Get()
  @Access.customer()
  @ApiOperation({ summary: "The signed-in customer's saved addresses, default first" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: { type: "array", items: saved } }, required: ["data"], additionalProperties: false } })
  async list(@CurrentCustomer() customer: SignedIn, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await listAddresses(db(), customer) }
  }

  @Post()
  @Access.customer()
  @ApiOperation({ summary: "Save an address; the first one becomes the default" })
  @ApiBody({ schema: { type: "object", properties: { address: input, isDefault: { type: "boolean" } }, required: ["address"] } })
  @ApiCreatedResponse({ schema: one })
  async create(@CurrentCustomer() customer: SignedIn, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await createAddress(db(), customer, readJson(req.chaanavya.body)) }
  }

  @Patch(":addressId")
  @Access.customer()
  @ApiOperation({ summary: "Change some fields of one of the customer's addresses; the result is checked as a whole" })
  @ApiBody({ schema: { type: "object", properties: { address: { ...input, required: [] } }, required: ["address"] } })
  @ApiOkResponse({ schema: one })
  async update(@CurrentCustomer() customer: SignedIn, @Param("addressId") addressId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await updateAddress(db(), customer, addressId, readJson(req.chaanavya.body)) }
  }

  @Post(":addressId/default")
  @HttpCode(200)
  @Access.customer()
  @ApiOperation({ summary: "Make one of the customer's addresses the default" })
  @ApiOkResponse({ schema: one })
  async makeDefault(@CurrentCustomer() customer: SignedIn, @Param("addressId") addressId: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await setDefaultAddress(db(), customer, addressId) }
  }

  @Delete(":addressId")
  @HttpCode(204)
  @Access.customer()
  @ApiOperation({ summary: "Delete one of the customer's addresses; orders keep their own copy" })
  async remove(@CurrentCustomer() customer: SignedIn, @Param("addressId") addressId: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    await deleteAddress(db(), customer, addressId)
  }
}
