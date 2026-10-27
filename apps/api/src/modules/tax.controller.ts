// GST configuration for the admin workspace (Stage 12.05). OWNER only (settings.manage): draft a tax
// profile, sign it with the tax advisor's reference, make it active, and see what still blocks live
// sales. Rules in apps/api/src/tax/profile.ts.
import { Controller, Get, HttpCode, Param, Post, Put, Req, Res } from "@nestjs/common"
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { readJson, requireReason, uuidParam } from "../admin/api.ts"
import type { StaffActor } from "../auth/session.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import type { ApiRequest } from "../http/context.ts"
import { activateTaxProfile, approveTaxProfile, createTaxProfile, listTaxProfiles, taxReadiness, updateTaxProfile, type TaxChange } from "../tax/profile.ts"

const change = (staff: StaffActor, req: ApiRequest): TaxChange => ({ actor: { kind: "staff", id: staff.userId }, correlationId: req.chaanavya.correlationId })

const text = { type: "string" }
const rate = { type: "object", properties: { taxCategory: text, hsnCode: { ...text, pattern: "^([0-9]{4}|[0-9]{6}|[0-9]{8})$" }, rateBasisPoints: { type: "integer", minimum: 0, maximum: 4000, description: "GST in basis points, 5% = 500" } }, required: ["taxCategory", "hsnCode", "rateBasisPoints"], additionalProperties: false }
const profile = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["draft", "approved", "retired"] },
    active: { type: "boolean" },
    sellerStateCode: text,
    gstin: { type: ["string", "null"] },
    pricesIncludeTax: { type: "boolean" },
    note: text,
    rates: { type: "array", items: rate },
    approval: { type: ["object", "null"], properties: { approvedById: { type: "string", format: "uuid" }, approvedAt: { type: "string", format: "date-time" }, signedName: text, advisorReference: text } },
    activatedAt: { type: ["string", "null"], format: "date-time" },
    retiredAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "status", "active", "sellerStateCode", "gstin", "pricesIncludeTax", "note", "rates", "approval", "activatedAt", "retiredAt", "createdAt", "updatedAt"],
}
const one = { type: "object", properties: { data: profile }, required: ["data"] }
const input = { type: "object", properties: { sellerStateCode: { ...text, description: "ISO 3166-2:IN, for example IN-KA" }, gstin: { type: ["string", "null"] }, pricesIncludeTax: { type: "boolean" }, note: text, rates: { type: "array", items: rate } }, required: ["sellerStateCode", "rates"] }

@ApiTags("admin")
@Controller("api/v1/admin/tax")
export class TaxController {
  @Get("profiles")
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "Tax profiles, the active one first" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: { type: "array", items: profile } }, required: ["data"] } })
  async list(@Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await listTaxProfiles(db()) }
  }

  @Post("profiles")
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "Start a draft tax profile: seller state, GSTIN, and HSN code and GST rate per tax category" })
  @ApiBody({ schema: input })
  @ApiCreatedResponse({ schema: one })
  async create(@CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await createTaxProfile(db(), readJson(req.chaanavya.body, 64 * 1024), change(staff, req)) }
  }

  @Put("profiles/:id")
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "Replace a draft's values and rates; an approved profile never changes" })
  @ApiBody({ schema: input })
  @ApiOkResponse({ schema: one })
  async update(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await updateTaxProfile(db(), uuidParam(id), readJson(req.chaanavya.body, 64 * 1024), change(staff, req)) }
  }

  @Post("profiles/:id/approve")
  @HttpCode(200)
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "Sign a complete draft: confirm a qualified tax advisor checked it, give the advisor's reference, type your full name" })
  @ApiBody({ schema: { type: "object", properties: { statement: { type: "boolean" }, advisorReference: text, signedName: text, reason: text }, required: ["statement", "advisorReference", "signedName", "reason"] } })
  @ApiOkResponse({ schema: one })
  async approve(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const body = readJson(req.chaanavya.body)
    const approval = {
      statement: body.statement === true,
      advisorReference: typeof body.advisorReference === "string" ? body.advisorReference : "",
      signedName: typeof body.signedName === "string" ? body.signedName : "",
      reason: requireReason(body),
    }
    return { data: await approveTaxProfile(db(), uuidParam(id), approval, change(staff, req)) }
  }

  @Post("profiles/:id/activate")
  @HttpCode(200)
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "Make an approved profile the one checkout uses; the previous one is retired" })
  @ApiBody({ schema: { type: "object", properties: { reason: text }, required: ["reason"] } })
  @ApiOkResponse({ schema: one })
  async activate(@Param("id") id: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await activateTaxProfile(db(), uuidParam(id), requireReason(readJson(req.chaanavya.body)), change(staff, req)) }
  }

  @Get("readiness")
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "What blocks live sales for tax reasons; ready only with an approved, active profile covering every sellable variant" })
  @ApiOkResponse({ schema: { type: "object", properties: { data: { type: "object", properties: { ready: { type: "boolean" }, profileId: { type: ["string", "null"], format: "uuid" }, blockers: { type: "array", items: { type: "object", properties: { code: { type: "string", enum: ["no_active_profile", "unassigned_category", "unmapped_category"] }, message: text, taxCategory: text }, required: ["code", "message"] } } }, required: ["ready", "profileId", "blockers"] } }, required: ["data"] } })
  async readiness(@Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    return { data: await taxReadiness(db()) }
  }
}
