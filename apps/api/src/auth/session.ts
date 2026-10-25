// Session verification and authorization rules (Stage 05; the API's single session verifier since
// Stage 07). Framework-neutral: the NestJS guards in src/http/access.ts call these with the request's
// headers. Semantics are unchanged from the Next.js guards they replace:
//
//   customer    any signed-in user (customers; staff act as customers here)
//   permission  a staff role granting the capability AND a session that passed two-factor sign-in;
//               otherwise 401/403, and every 403 is audited
//   shopper     no requirement; the handler decides ownership (guest or customer) itself
//
// Mutating requests must come from the shop or admin site (Origin / Sec-Fetch-Site), checked
// against the host the browser used, which the web host forwards (src/http/internal-caller.ts).
import { twoFactorWaived } from "@chaanavya/shared/auth/two-factor-waiver"
import { capabilitiesFor, type Capability } from "@chaanavya/shared/auth/rbac"
import { createLogger } from "@chaanavya/shared/observability/logger"
import { db } from "../db/client.ts"
import { recordIdentityEvent } from "./audit.ts"
import { findGuestSession } from "./guest.ts"
import { auth } from "./server.ts"

export type AuthErrorCode = "unauthenticated" | "forbidden" | "mfa_required" | "account_disabled" | "reauthentication_required" | "cross_site" | "not_found"

export class AuthError extends Error {
  readonly status: number
  readonly code: AuthErrorCode
  constructor(status: number, code: AuthErrorCode) {
    super(code)
    this.status = status
    this.code = code
  }
}

export type SignedIn = {
  userId: string
  email: string
  emailVerified: boolean
  sessionId: string
  sessionCreatedAt: Date
  authMethod: string
  twoFactorEnabled: boolean
  roles: string[]
}

export type StaffActor = SignedIn & { capabilities: Set<Capability> }

/** What the API knows about the request beyond its headers (set by the HTTP layer). */
export type RequestFacts = { method: string; path: string; host: string; correlationId: string }

/**
 * Rejects cross-site writes. Browsers send Sec-Fetch-Site or Origin on every cross-site POST/DELETE.
 * Requests with neither header (curl, server to server) cannot ride on a victim's cookies.
 */
export function assertSameOrigin(headers: Headers, facts: Pick<RequestFacts, "method" | "host">) {
  if (facts.method === "GET" || facts.method === "HEAD") return
  const site = headers.get("sec-fetch-site")
  if (site) {
    if (site !== "same-origin") throw new AuthError(403, "cross_site")
    return
  }
  const origin = headers.get("origin")
  if (!origin) return
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw new AuthError(403, "cross_site")
  }
  if (originHost !== facts.host) throw new AuthError(403, "cross_site")
}

/** The signed-in user for these headers, or null. Disabled users count as signed out. */
export async function getSignedIn(headers: Headers): Promise<SignedIn | null> {
  const result = await auth().api.getSession({ headers })
  if (!result) return null
  const user = await db().user.findUnique({
    where: { id: result.user.id },
    select: { email: true, emailVerified: true, twoFactorEnabled: true, disabledAt: true, roles: { select: { role: true } } },
  })
  if (!user || user.disabledAt) return null
  const session = result.session as typeof result.session & { authMethod?: string }
  return {
    userId: result.user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    sessionId: session.id,
    sessionCreatedAt: new Date(session.createdAt),
    authMethod: session.authMethod ?? "unknown",
    twoFactorEnabled: user.twoFactorEnabled,
    roles: user.roles.map(r => r.role),
  }
}

export async function requireCustomer(headers: Headers): Promise<SignedIn> {
  const signedIn = await getSignedIn(headers)
  if (!signedIn) throw new AuthError(401, "unauthenticated")
  return signedIn
}

// The development-only switch (ADMIN_TWO_FACTOR=off) waives this; it never takes effect outside development.
const passedTwoFactor = (signedIn: SignedIn) => twoFactorWaived(process.env) || (signedIn.twoFactorEnabled && signedIn.authMethod === "password_2fa")

/** Staff actor if these headers may use `capability`, else null (no audit, no error). */
export async function tryStaff(headers: Headers, capability: Capability): Promise<StaffActor | null> {
  const signedIn = await getSignedIn(headers)
  if (!signedIn) return null
  const capabilities = capabilitiesFor(signedIn.roles)
  return capabilities.has(capability) && passedTwoFactor(signedIn) ? { ...signedIn, capabilities } : null
}

export async function requirePermission(headers: Headers, facts: RequestFacts, capability: Capability): Promise<StaffActor> {
  const signedIn = await requireCustomer(headers)
  const capabilities = capabilitiesFor(signedIn.roles)
  let denial: AuthError | null = null
  if (!capabilities.has(capability)) denial = new AuthError(403, "forbidden")
  else if (!passedTwoFactor(signedIn)) denial = new AuthError(403, "mfa_required")
  if (denial) {
    await recordIdentityEvent(db(), {
      action: "identity.access_denied",
      actor: { kind: signedIn.roles.length ? "staff" : "customer", id: signedIn.userId },
      entity: { type: "route", id: facts.path },
      reason: `${denial.code}:${capability}`,
      correlationId: facts.correlationId,
    })
    createLogger({ correlationId: facts.correlationId }).warn("auth.access_denied", { capability, code: denial.code })
    throw denial
  }
  return { ...signedIn, capabilities }
}

/** Who is shopping: a signed-in customer, a guest session, or neither. `emailVerified` is the signed-in user's. */
export async function resolveShopper(headers: Headers) {
  const [signedIn, guest] = await Promise.all([getSignedIn(headers), findGuestSession(db(), headers)])
  return { userId: signedIn?.userId ?? null, emailVerified: signedIn?.emailVerified ?? false, guestSessionId: guest?.id ?? null }
}

/** True only when the record belongs to this shopper. A guest never matches a customer's record. */
export function ownsRecord(shopper: { userId: string | null; guestSessionId: string | null }, record: { userId: string | null; guestSessionId: string | null }) {
  if (shopper.userId && record.userId === shopper.userId) return true
  return Boolean(shopper.guestSessionId && record.guestSessionId === shopper.guestSessionId)
}
