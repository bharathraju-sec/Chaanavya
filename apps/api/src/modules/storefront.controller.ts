// Public catalogue API (Stage 08; the storefront moves onto it in Stage 10). Anyone may read it, so
// it only ever returns live products, their active variants, approved photos and visible
// collections. A draft, archived or unknown handle is the same 404.
import { Controller, Get, Param, Req, Res } from "@nestjs/common"
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { ApiError, decodeCursor, parsePage } from "../admin/api.ts"
import { createLogger } from "@chaanavya/shared/observability/logger"
import { publicCollectionPage, publicCollections, publicProductPage, publicProducts, type ProductPage } from "../catalogue/public.ts"
import { HANDLE } from "../catalogue/rules.ts"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"
import { queryOf, type ApiRequest } from "../http/context.ts"
import { CatalogueSchemas, data, list } from "../http/schemas.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
// A cursor is only a position (published time and ID of the last item shown); a forged one is a 400,
// and it can never widen the publication filter.
const isAfter = (v: unknown): v is { publishedAt: string; id: string } => {
  const { id, publishedAt } = (v ?? {}) as { id?: unknown; publishedAt?: unknown }
  return typeof id === "string" && UUID.test(id) && typeof publishedAt === "string" && ISO_TIME.test(publishedAt) && !Number.isNaN(Date.parse(publishedAt))
}
const collectionPage = {
  type: "object",
  properties: { version: { type: "integer", enum: [1] }, collection: CatalogueSchemas.publicCollection, products: { type: "array", items: CatalogueSchemas.publicProduct } },
  required: ["version", "collection", "products"],
  additionalProperties: false,
}
const cacheable = (res: Response) => res.setHeader("cache-control", "public, max-age=60")

@ApiTags("catalogue")
@Controller("api/v1/catalogue")
export class StorefrontCatalogueController {
  @Get("products")
  @Access.shopper()
  @ApiOperation({ summary: "Live products, newest first, optionally in one visible collection" })
  @ApiQuery({ name: "collection", required: false, description: "Collection handle" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 48 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(CatalogueSchemas.publicProduct) })
  async products(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query, { defaultLimit: 24, maxLimit: 48 })
    const collection = query.get("collection")
    if (collection !== null && !HANDLE.test(collection)) throw new ApiError(404, "not_found", "not found")
    const { items, nextCursor } = await publicProducts(db(), { collectionHandle: collection, limit, after: decodeCursor(cursor, isAfter) })
    cacheable(res)
    return { data: items, page: { nextCursor } }
  }

  @Get("products/:handle")
  @Access.shopper()
  @ApiOperation({ summary: "One live product by its handle, and the variant to show first" })
  @ApiQuery({ name: "variant", required: false, description: "Variant ID the shopper chose (a link or a size); ignored if it is not an active variant of this product" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: CatalogueSchemas.publicProduct, selection: CatalogueSchemas.productSelection }, required: ["data", "selection"], additionalProperties: false } })
  async product(@Param("handle") handle: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const variant = queryOf(req).get("variant")
    if (variant !== null && !UUID.test(variant)) throw new ApiError(400, "invalid_request", "variant must be a variant ID", { variant: "malformed" })
    const page: ProductPage = HANDLE.test(handle) ? await publicProductPage(db(), handle, variant) : { found: false, reason: "missing" }
    if (!page.found) {
      // Missing and hidden read the same to shoppers, so drafts cannot be discovered; the log tells them apart.
      createLogger({ correlationId: req.chaanavya.correlationId }).info("catalogue.product_not_public", { reason: page.reason })
      throw new ApiError(404, "not_found", "not found")
    }
    cacheable(res)
    return { data: page.product, selection: page.selection }
  }

  @Get("collections/:handle")
  @Access.shopper()
  @ApiOperation({ summary: "One visible collection and a page of its live products, newest first" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 48 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: { type: "object", properties: { data: collectionPage, page: CatalogueSchemas.pageInfo }, required: ["data", "page"], additionalProperties: false } })
  async collection(@Param("handle") handle: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query, { defaultLimit: 24, maxLimit: 48 })
    const after = decodeCursor(cursor, isAfter)
    const found = HANDLE.test(handle) ? await publicCollectionPage(db(), handle, { limit, after }) : null
    if (!found) throw new ApiError(404, "not_found", "not found")
    cacheable(res)
    return { data: found.page, page: { nextCursor: found.nextCursor } }
  }

  @Get("collections")
  @Access.shopper()
  @ApiOperation({ summary: "Visible collections" })
  @ApiOkResponse({ schema: data({ type: "array", items: CatalogueSchemas.publicCollection }) })
  async collections(@Res({ passthrough: true }) res: Response) {
    cacheable(res)
    return { data: await publicCollections(db()) }
  }
}
