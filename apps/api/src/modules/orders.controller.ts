// One order (Stage 05; moved from app/api/orders/[id] in Stage 07, same behaviour): its owner
// (signed-in customer or the guest session that placed it) or staff with orders.read and two-factor
// sign-in. Everyone else gets the same 404 as a missing order, so order IDs cannot be probed.
import { Controller, Get, Param, Req, Res } from "@nestjs/common"
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { UUID } from "../admin/api.ts"
import { AuthError, ownsRecord, resolveShopper, tryStaff } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { toPaise } from "../db/money.ts"
import { Access } from "../http/access.ts"
import { headersOf, type ApiRequest } from "../http/context.ts"
import { Schemas } from "../http/schemas.ts"

const notFound = () => new AuthError(404, "not_found")

@ApiTags("orders")
@Controller("api/v1/orders")
export class OrdersController {
  @Get(":id")
  @Access.shopper()
  @ApiOperation({ summary: "One order, for its owner or for staff with orders.read" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        number: { type: "string" },
        status: { type: "string" },
        fulfilmentStatus: { type: "string" },
        grandTotal: Schemas.money,
        createdAt: { type: "string", format: "date-time" },
        items: {
          type: "array",
          items: { type: "object", properties: { productTitle: { type: "string" }, variantTitle: { type: "string" }, quantity: { type: "integer" }, lineTotalPaise: { type: "integer" } }, required: ["productTitle", "variantTitle", "quantity", "lineTotalPaise"] },
        },
      },
      required: ["id", "number", "status", "fulfilmentStatus", "grandTotal", "createdAt", "items"],
    },
  })
  async one(@Param("id") id: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    if (!UUID.test(id)) throw notFound()
    const order = await db().order.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        userId: true,
        guestSessionId: true,
        status: true,
        fulfilmentStatus: true,
        grandTotalPaise: true,
        currency: true,
        createdAt: true,
        items: { select: { productTitle: true, variantTitle: true, quantity: true, lineTotalPaise: true } },
      },
    })
    if (!order) throw notFound()
    const headers = headersOf(req)
    const allowed = ownsRecord(await resolveShopper(headers), order) || (await tryStaff(headers, "orders.read")) !== null
    if (!allowed) throw notFound()
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      fulfilmentStatus: order.fulfilmentStatus,
      grandTotal: { amountPaise: toPaise(order.grandTotalPaise), currency: order.currency },
      createdAt: order.createdAt,
      items: order.items.map(i => ({ productTitle: i.productTitle, variantTitle: i.variantTitle, quantity: i.quantity, lineTotalPaise: toPaise(i.lineTotalPaise) })),
    }
  }
}
