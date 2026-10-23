// Admin page gates (Stage 06; since Stage 07 they ask the API who is signed in). Every admin page
// calls requireAdminPage on the server for every request; hiding navigation items is only a
// convenience. The API enforces the same rules again on every admin API call, so a page that
// rendered by mistake still could not read or change anything.
import { cache } from "react"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { adminAllowedHere, adminBasePath } from "@chaanavya/shared/admin/host"
import type { Capability } from "@chaanavya/shared/auth/rbac"
import { currentSession, type SessionUser } from "@/lib/api/server"

export type AdminStaff = { userId: string; email: string; roles: string[]; capabilities: ReadonlySet<Capability> }
export type AdminPageContext = { staff: AdminStaff; base: string; allowed: boolean; twoFactorWaived: boolean }

/**
 * For every admin page. Customers and unknown visitors never learn the admin exists (404);
 * signed-out staff go to the login page; staff without two-factor go to enrolment; a session
 * that skipped the second factor must sign in again. `allowed` is false when the role lacks the
 * page's capability: the page then shows an access notice instead of its content.
 */
export async function requireAdminPage(capability?: Capability): Promise<AdminPageContext> {
  const { staff, base, twoFactorWaived } = await currentAdmin()
  return { staff, base, allowed: !capability || staff.capabilities.has(capability), twoFactorWaived }
}

// One session lookup per request, shared by the workspace layout and the page.
const currentAdmin = cache(async (): Promise<{ staff: AdminStaff; base: string; twoFactorWaived: boolean }> => {
  const h = await headers()
  if (!adminAllowedHere(h)) notFound()
  const base = adminBasePath(h)
  const session = await currentSession()
  const user = session.signedIn ? session.user : undefined
  if (!user) redirect(`${base}/login`)
  if (user.roles.length === 0) notFound()
  // Development only: the API reports twoFactorWaived when ADMIN_TWO_FACTOR=off (never in staging or production).
  const waived = user.twoFactorWaived === true
  if (!waived && !user.twoFactorEnabled) redirect(`${base}/setup-mfa`)
  if (!waived && !user.passedTwoFactor) redirect(`${base}/login?verify=1`)
  return { staff: { userId: user.id, email: user.email, roles: user.roles, capabilities: new Set(user.capabilities as Capability[]) }, base, twoFactorWaived: waived }
})

/** For the login and two-factor enrolment pages, which must work before full sign-in. */
export async function adminEntryContext(): Promise<{ base: string; signedIn: SessionUser | null }> {
  const h = await headers()
  if (!adminAllowedHere(h)) notFound()
  const base = adminBasePath(h)
  const session = await currentSession()
  return { base, signedIn: (session.signedIn && session.user) || null }
}
