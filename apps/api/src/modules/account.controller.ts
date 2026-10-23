// Customer account endpoints (Stage 05; moved from app/api/account in Stage 07, same behaviour).
import { Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { claimGuestOrder, isRecentSignIn } from "../auth/claim.ts"
import { AuthError, type SignedIn } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { toPaise } from "../db/money.ts"
import { Access, CurrentCustomer } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { Schemas } from "../http/schemas.ts"

@ApiTags("account")
@Controller("api/v1/account")
export class AccountController {
  /** The signed-in customer's own orders, newest first. Never another account's or a guest's. */
  @Get("orders")
  @Access.customer()
  @ApiOperation({ summary: "The signed-in customer's own orders, newest first" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        orders: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" }, number: { type: "string" }, status: { type: "string" }, fulfilmentStatus: { type: "string" }, grandTotal: Schemas.money, createdAt: { type: "string", format: "date-time" } },
            required: ["id", "number", "status", "fulfilmentStatus", "grandTotal", "createdAt"],
          },
        },
      },
      required: ["orders"],
    },
  })
  async orders(@CurrentCustomer() customer: SignedIn, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const orders = await db().order.findMany({
      where: { userId: customer.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, number: true, status: true, fulfilmentStatus: true, grandTotalPaise: true, currency: true, createdAt: true },
    })
    return { orders: orders.map(({ grandTotalPaise, currency, ...o }) => ({ ...o, grandTotal: { amountPaise: toPaise(grandTotalPaise), currency } })) }
  }

  /**
   * Links one guest order to the signed-in customer when the order's email equals the customer's
   * verified email. Requires a sign-in in the last 15 minutes. Every refusal reads "not_found".
   */
  @Post("claim-order")
  @HttpCode(200)
  @Access.customer()
  @ApiOperation({ summary: "Attach a guest order placed with this verified email" })
  @ApiBody({ schema: Schemas.claim })
  @ApiOkResponse({ schema: { type: "object", properties: { status: { type: "string", enum: ["claimed"] } }, required: ["status"] } })
  async claim(@CurrentCustomer() customer: SignedIn, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!isRecentSignIn(customer)) throw new AuthError(403, "reauthentication_required")
    let orderNumber: unknown
    try {
      orderNumber = (JSON.parse(req.chaanavya.body.text ?? "") as { orderNumber?: unknown } | null)?.orderNumber
    } catch {
      orderNumber = undefined
    }
    const outcome = await claimGuestOrder(db(), customer, orderNumber, req.chaanavya.correlationId)
    if (outcome !== "claimed") throw new AuthError(404, "not_found")
    return { status: "claimed" }
  }
}
