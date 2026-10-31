// Route access rules for the NestJS API (Stage 07), with the same semantics as the Stage 05/06
// Next.js wrappers they replace (withPermission, withCustomer, commerceRoute):
//
//   @Access.permission("staff.manage")  same-origin check, then 404 off the admin host, then a staff
//                                       role with the capability and a two-factor session (401/403,
//                                       denials audited)
//   @Access.customer()                  same-origin check, then any signed-in user (401)
//   @Access.shopper()                   same-origin check only; the handler decides ownership
//   @Access.probe()                     health probes, no checks
//   @Access.webhook()                   a payment provider calling us (Stage 14.09): no same-origin check
//                                       and no session (the provider has neither); the handler accepts
//                                       nothing until the provider's signature over the raw body verifies
//
// AccessGuard is registered globally: a route without a rule is refused (fails closed), and the
// static test in tests/security/api/routes.test.mjs checks that every route declares one.
import { createParamDecorator, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { adminAllowedHere } from "@chaanavya/shared/admin/host"
import type { Capability } from "@chaanavya/shared/auth/rbac"
import { assertSameOrigin, AuthError, requireCustomer, requirePermission, type SignedIn, type StaffActor } from "../auth/session.ts"
import { factsOf, headersOf, type ApiRequest } from "./context.ts"

export type AccessRule = { kind: "permission"; capability: Capability } | { kind: "customer" } | { kind: "shopper" } | { kind: "probe" } | { kind: "webhook" }

export const ACCESS_RULE = "chaanavya:access"

export const Access = {
  permission: (capability: Capability) => SetMetadata(ACCESS_RULE, { kind: "permission", capability } satisfies AccessRule),
  customer: () => SetMetadata(ACCESS_RULE, { kind: "customer" } satisfies AccessRule),
  shopper: () => SetMetadata(ACCESS_RULE, { kind: "shopper" } satisfies AccessRule),
  probe: () => SetMetadata(ACCESS_RULE, { kind: "probe" } satisfies AccessRule),
  webhook: () => SetMetadata(ACCESS_RULE, { kind: "webhook" } satisfies AccessRule),
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_RULE, [context.getHandler(), context.getClass()])
    if (!rule) throw new Error(`no access rule on ${context.getClass().name}.${context.getHandler().name}`)
    if (rule.kind === "probe" || rule.kind === "webhook") return true
    const req = context.switchToHttp().getRequest<ApiRequest>()
    const headers = headersOf(req)
    const facts = factsOf(req)
    assertSameOrigin(headers, facts)
    if (rule.kind === "customer") req.chaanavya.customer = await requireCustomer(headers)
    if (rule.kind === "permission") {
      // Admin APIs answer only on the admin host when ADMIN_URL is set (decision 029).
      if (!adminAllowedHere(new Headers({ host: facts.host }))) throw new AuthError(404, "not_found")
      req.chaanavya.staff = await requirePermission(headers, facts, rule.capability)
    }
    return true
  }
}

/** The signed-in customer set by @Access.customer(). */
export const CurrentCustomer = createParamDecorator((_data: unknown, context: ExecutionContext): SignedIn => {
  const customer = context.switchToHttp().getRequest<ApiRequest>().chaanavya.customer
  if (!customer) throw new Error("CurrentCustomer used without @Access.customer()")
  return customer
})

/** The staff member set by @Access.permission(). */
export const CurrentStaff = createParamDecorator((_data: unknown, context: ExecutionContext): StaffActor => {
  const staff = context.switchToHttp().getRequest<ApiRequest>().chaanavya.staff
  if (!staff) throw new Error("CurrentStaff used without @Access.permission()")
  return staff
})
