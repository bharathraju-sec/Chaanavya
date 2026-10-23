// Admin API (Stage 06; moved from app/api/admin in Stage 07 with identical rules and responses):
// staff and roles, sign-out everywhere, deactivation, configuration status and the audit trail.
// Every route needs a staff role with the capability, a two-factor session and (when ADMIN_URL is set)
// the admin host. Changes need a written reason and the record's current ETag (If-Match), and each
// change commits together with its canonical audit event (src/auth/staff.ts).
import { Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common"
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { checkEnv } from "@chaanavya/shared/config/env"
import { STAFF_ROLES } from "@chaanavya/shared/auth/rbac"
import { assertIfMatch, decodeCursor, oneOf, pageOf, parsePage, readJson, requireReason, uuidParam } from "../admin/api.ts"
import { listAudit, parseAuditFilters } from "../admin/audit-query.ts"
import { listStaff, loadStaff, type StaffView } from "../admin/staff-view.ts"
import type { StaffActor } from "../auth/session.ts"
import { deactivateUser, grantRole, revokeAllSessions, revokeRole } from "../auth/staff.ts"
import { db } from "../db/client.ts"
import { Access, CurrentStaff } from "../http/access.ts"
import { queryOf, type ApiRequest } from "../http/context.ts"
import { data, list, Schemas } from "../http/schemas.ts"

const isStaffCursor = (v: unknown): v is { id: string } => typeof (v as { id?: unknown })?.id === "string"
const ifMatch = { name: "If-Match", required: true, description: "The ETag from GET /api/v1/admin/staff/{userId}" }
const outcome = (values: string[]) => data({ type: "object", properties: { outcome: { type: "string", enum: values }, staff: Schemas.staff }, required: ["outcome", "staff"] })

function send(res: Response, body: unknown, etag?: string) {
  res.setHeader("cache-control", "no-store")
  if (etag) res.setHeader("etag", etag)
  return body
}

@ApiTags("admin")
@Controller("api/v1/admin")
export class AdminController {
  /** The signed-in staff member's roles and capabilities. */
  @Get("me")
  @Access.permission("orders.read")
  @ApiOperation({ summary: "The signed-in staff member's roles and capabilities" })
  @ApiOkResponse({ schema: Schemas.me })
  me(@CurrentStaff() staff: StaffActor, @Res({ passthrough: true }) res: Response) {
    return send(res, { userId: staff.userId, roles: staff.roles, capabilities: [...staff.capabilities].sort() })
  }

  /** Which configuration this API instance has. Names and status only; values never leave the server. */
  @Get("settings")
  @Access.permission("settings.manage")
  @ApiOperation({ summary: "Configuration status of the API (names only, never values)" })
  @ApiOkResponse({ schema: data({ type: "object", properties: { environment: { type: "string" }, settings: { type: "array", items: Schemas.setting }, problems: { type: "array", items: Schemas.problem } }, required: ["environment", "settings", "problems"] }) })
  settings(@Res({ passthrough: true }) res: Response) {
    const report = checkEnv(process.env, { service: "api" })
    return send(res, { data: { environment: report.environment, settings: report.settings, problems: report.errors } })
  }

  /** Audit trail, newest first. */
  @Get("audit")
  @Access.permission("audit.read")
  @ApiOperation({ summary: "Audit trail, newest first" })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "entityType", required: false })
  @ApiQuery({ name: "entityId", required: false })
  @ApiQuery({ name: "actorId", required: false })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(Schemas.auditEvent) })
  async audit(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const query = queryOf(req)
    const { limit, cursor } = parsePage(query, { defaultLimit: 50 })
    const { items, nextCursor } = await listAudit(db(), { filters: parseAuditFilters(name => query.get(name)), limit, cursor })
    return send(res, { data: items, page: { nextCursor } })
  }

  /** Staff list with an ETag per person (send it back as If-Match when changing them). */
  @Get("staff")
  @Access.permission("staff.manage")
  @ApiOperation({ summary: "Staff list; each entry carries the ETag to send as If-Match" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: list(Schemas.staff) })
  async staffList(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const { limit, cursor } = parsePage(queryOf(req))
    const after = decodeCursor(cursor, isStaffCursor)
    const rows = await listStaff(db(), { limit, afterId: after?.id ?? null })
    const { items, nextCursor } = pageOf(rows, limit, row => ({ id: row.id }))
    return send(res, { data: items, page: { nextCursor } })
  }

  @Get("staff/:userId")
  @Access.permission("staff.manage")
  @ApiOperation({ summary: "One staff member, with the ETag to send as If-Match on changes" })
  @ApiOkResponse({ schema: data(Schemas.staff) })
  async staffOne(@Param("userId") userId: string, @Res({ passthrough: true }) res: Response) {
    const view = await loadStaff(db(), uuidParam(userId))
    return send(res, { data: view }, view.etag)
  }

  /** Grant a role. Never to yourself. */
  @Post("staff/:userId/roles")
  @HttpCode(200)
  @Access.permission("staff.manage")
  @ApiOperation({ summary: "Grant a role (needs a reason and If-Match; never to yourself)" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: Schemas.grant })
  @ApiOkResponse({ schema: outcome(["granted", "unchanged"]) })
  async grant(@Param("userId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const userId = uuidParam(rawId)
    const current = await loadStaff(db(), userId)
    assertIfMatch(req.headers["if-match"], current.etag)
    const body = readJson(req.chaanavya.body)
    const role = oneOf(body.role, STAFF_ROLES, "role")
    const result = await grantRole(db(), { userId, role, actor: { kind: "staff", id: staff.userId }, reason: requireReason(body), correlationId: req.chaanavya.correlationId })
    return this.changed(res, userId, result)
  }

  /** Remove a role and end the person's sessions. Never your own; never the last active owner. */
  @Delete("staff/:userId/roles/:role")
  @HttpCode(200)
  @Access.permission("staff.manage")
  @ApiOperation({ summary: "Remove a role and sign the person out (needs a reason and If-Match)" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: Schemas.reason })
  @ApiOkResponse({ schema: outcome(["revoked", "unchanged"]) })
  async revoke(@Param("userId") rawId: string, @Param("role") rawRole: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const userId = uuidParam(rawId)
    const role = oneOf(rawRole, STAFF_ROLES, "role")
    const current = await loadStaff(db(), userId)
    assertIfMatch(req.headers["if-match"], current.etag)
    const body = readJson(req.chaanavya.body)
    const result = await revokeRole(db(), { userId, role, actor: { kind: "staff", id: staff.userId }, reason: requireReason(body), correlationId: req.chaanavya.correlationId })
    return this.changed(res, userId, result)
  }

  /** Deactivate a person: they keep their history, lose every session and cannot sign in. */
  @Post("staff/:userId/deactivate")
  @HttpCode(200)
  @Access.permission("staff.manage")
  @ApiOperation({ summary: "Deactivate a person (needs a reason and If-Match; never yourself or the last owner)" })
  @ApiHeader(ifMatch)
  @ApiBody({ schema: Schemas.reason })
  @ApiOkResponse({ schema: outcome(["deactivated", "unchanged"]) })
  async deactivate(@Param("userId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const userId = uuidParam(rawId)
    const current = await loadStaff(db(), userId)
    assertIfMatch(req.headers["if-match"], current.etag)
    const body = readJson(req.chaanavya.body)
    const result = await deactivateUser(db(), { userId, actor: { kind: "staff", id: staff.userId }, reason: requireReason(body), correlationId: req.chaanavya.correlationId })
    return this.changed(res, userId, result)
  }

  /** Sign a person out everywhere (lost device, leaver, suspected compromise). */
  @Delete("staff/:userId/sessions")
  @HttpCode(200)
  @Access.permission("staff.manage")
  @ApiOperation({ summary: "Sign a person out on every device (needs a reason)" })
  @ApiBody({ schema: Schemas.reason })
  @ApiOkResponse({ schema: data({ type: "object", properties: { revoked: { type: "integer" } }, required: ["revoked"] }) })
  async signOutEverywhere(@Param("userId") rawId: string, @CurrentStaff() staff: StaffActor, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const userId = uuidParam(rawId)
    await loadStaff(db(), userId)
    const body = readJson(req.chaanavya.body)
    const revoked = await revokeAllSessions(db(), { userId, actor: { kind: "staff", id: staff.userId }, reason: requireReason(body), correlationId: req.chaanavya.correlationId })
    return send(res, { data: { revoked } })
  }

  private async changed(res: Response, userId: string, result: string) {
    const updated: StaffView = await loadStaff(db(), userId)
    return send(res, { data: { outcome: result, staff: updated } }, updated.etag)
  }
}
