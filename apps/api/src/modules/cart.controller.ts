// The shopper's bag (Stages 11.02 to 11.10): kept in the database for a verified customer account or a guest session.
// A guest session is started only when an anonymous shopper first adds something, never on a read,
// so browsing creates no rows. Its cookie holds a random token (only its hash is stored, see
// src/auth/guest.ts) and is HttpOnly, SameSite=Lax, and Secure over https. Responses never name the
// shopper and are never cached. A cart, line or session that is not the caller's is a plain 404.
import type { GuestSessionId, Shopper } from "@chaanavya/contracts/modules/common"
import { resolveEnvironment } from "@chaanavya/shared/config/env"
import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common"
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { ApiError, readJson } from "../admin/api.ts"
import { createGuestSession, GUEST_COOKIE, guestCookieHeader, readGuestToken } from "../auth/guest.ts"
import { resolveShopper } from "../auth/session.ts"
import { addKeyOf, addLine, applyPromotion, clearCart, lineToAdd, readCart, readOwnedCart, removeLine, removePromotion, setLineQuantity } from "../cart/cart.ts"
import { cartOwnerOf } from "../cart/ownership.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import { headersOf, type ApiRequest } from "../http/context.ts"
import { Schemas } from "../http/schemas.ts"

const notFound = () => new ApiError(404, "not_found", "not found")

const line = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    variantId: { type: "string", format: "uuid" },
    quantity: { type: "integer" },
    title: { type: "string" },
    variantTitle: { type: "string" },
    handle: { type: "string" },
    imageUrl: { type: ["string", "null"] },
    unitPrice: Schemas.money,
  },
  required: ["id", "variantId", "quantity", "title", "variantTitle", "handle", "imageUrl", "unitPrice"],
  additionalProperties: false,
}
const cart = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    id: { type: "string", format: "uuid" },
    revision: { type: "integer" },
    lines: { type: "array", items: line },
    subtotal: Schemas.money,
    // Null when no code is applied; `reason` only when the applied code does not apply right now.
    promotion: { type: ["object", "null"], properties: { code: { type: "string" }, applied: { type: "boolean" }, reason: { type: "string" } }, required: ["code", "applied"], additionalProperties: false },
    discount: Schemas.money,
    total: Schemas.money,
    issues: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["unavailable"] }, lineId: { type: "string", format: "uuid" } }, required: ["kind", "lineId"] } },
    expiresAt: { type: "string", format: "date-time" },
  },
  required: ["version", "id", "revision", "lines", "subtotal", "promotion", "discount", "total", "issues", "expiresAt"],
  additionalProperties: false,
}
const cartOrNone = { type: "object", properties: { data: { oneOf: [cart, { type: "null" }] } }, required: ["data"], additionalProperties: false }

const secureCookies = (req: ApiRequest) => resolveEnvironment(process.env) === "production" || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https"
const clearGuestCookie = (req: ApiRequest) => `${GUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookies(req) ? "; Secure" : ""}`

/** The caller's cart owner; for a change, an anonymous caller gets a new guest session and its cookie. */
async function ownerFor(req: ApiRequest, res: Response, { start }: { start: boolean }) {
  const headers = headersOf(req)
  const owner = cartOwnerOf(await resolveShopper(headers))
  if (owner || !start) {
    // A guest cookie the shop no longer honours (expired, revoked or made up) is cleared.
    if (!owner && readGuestToken(headers)) res.setHeader("set-cookie", clearGuestCookie(req))
    return owner
  }
  const { session, token } = await createGuestSession(db())
  res.setHeader("set-cookie", guestCookieHeader(token, secureCookies(req)))
  return { kind: "guest", guestSessionId: session.id as GuestSessionId } satisfies Shopper
}

@ApiTags("cart")
@Controller("api/v1/cart")
export class CartController {
  @Get()
  @Access.shopper()
  @ApiOperation({ summary: "The shopper's bag, or null when they have none" })
  @ApiOkResponse({ schema: cartOrNone })
  async current(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const owner = await ownerFor(req, res, { start: false })
    return { data: owner ? await readCart(db(), owner) : null }
  }

  @Get(":cartId")
  @Access.shopper()
  @ApiOperation({ summary: "One of the shopper's own carts by id; any other id is the same 404" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: cart }, required: ["data"], additionalProperties: false } })
  async one(@Param("cartId") cartId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const owner = await ownerFor(req, res, { start: false })
    const found = owner ? await readOwnedCart(db(), owner, cartId) : null
    if (!found) throw notFound()
    return { data: found }
  }

  @Post("lines")
  @HttpCode(200)
  @Access.shopper()
  @ApiOperation({ summary: "Add a variant to the bag; starts a guest session for an anonymous shopper. Prices come from the catalogue, never the request" })
  @ApiHeader({ name: "Idempotency-Key", required: true, description: "8 to 100 letters, digits, - or _: a retry with the same key changes nothing" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: cart }, required: ["data"], additionalProperties: false } })
  async add(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const key = addKeyOf(req.headers["idempotency-key"])
    const line = await lineToAdd(db(), readJson(req.chaanavya.body))
    const owner = (await ownerFor(req, res, { start: true }))!
    return { data: await addLine(db(), owner, line, key) }
  }

  @Patch("lines/:lineId")
  @Access.shopper()
  @ApiOperation({ summary: "Set a line's quantity (0 to 10); 0 removes it. Raising needs the item on sale and enough free stock; lowering always works" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: cart }, required: ["data"], additionalProperties: false } })
  async update(@Param("lineId") lineId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const body = readJson(req.chaanavya.body)
    const owner = await ownerFor(req, res, { start: false })
    if (!owner) throw notFound()
    return { data: await setLineQuantity(db(), owner, lineId, body) }
  }

  @Delete("lines/:lineId")
  @Access.shopper()
  @ApiOperation({ summary: "Remove one line. Idempotent: a line not in the shopper's bag (already removed) changes nothing and the bag comes back as it is" })
  @ApiOkResponse({ schema: cartOrNone })
  async remove(@Param("lineId") lineId: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const owner = await ownerFor(req, res, { start: false })
    if (!owner) return { data: null }
    return { data: await removeLine(db(), owner, lineId) }
  }

  @Delete()
  @Access.shopper()
  @ApiOperation({ summary: "Empty the bag. Idempotent: an empty or missing bag changes nothing; never starts a guest session" })
  @ApiOkResponse({ schema: cartOrNone })
  async clear(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const owner = await ownerFor(req, res, { start: false })
    return { data: owner ? await clearCart(db(), owner) : null }
  }

  // Codes can be guessed by trying, so applying one has its own, much lower limit per IP.
  @Post("promotion")
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Access.shopper()
  @ApiOperation({ summary: "Apply a promo code to the bag. One code per bag: a valid new code replaces the current one; a code that does not apply is refused (400, fields.code = the reason) and the bag keeps its code" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: cart }, required: ["data"], additionalProperties: false } })
  async applyCode(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const body = readJson(req.chaanavya.body)
    const owner = await ownerFor(req, res, { start: false })
    if (!owner) throw new ApiError(404, "not_found", "add something to the bag first")
    return { data: await applyPromotion(db(), owner, body) }
  }

  @Delete("promotion")
  @Access.shopper()
  @ApiOperation({ summary: "Remove the promo code from the bag. Idempotent" })
  @ApiOkResponse({ schema: cartOrNone })
  async removeCode(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const owner = await ownerFor(req, res, { start: false })
    return { data: owner ? await removePromotion(db(), owner) : null }
  }
}
