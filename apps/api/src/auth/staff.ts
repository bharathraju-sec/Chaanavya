// Staff administration (Stages 05 and 06): creating staff, granting and revoking roles, deactivating
// users and ending sessions. Every change and its canonical audit event commit in one transaction.
// Passwords are hashed by Better Auth (scrypt); this file never stores or logs a plain password.
//
// Safety rules: the last active OWNER can never lose that role or be deactivated, and staff cannot
// change their own roles or deactivate themselves (another owner must).
import { ApiError } from "../admin/api.ts"
import type { Db, Tx } from "../db/client.ts"
import { recordAdminEvent, type AdminActor } from "../audit/catalogue.ts"
import type { StaffRole } from "@chaanavya/shared/auth/rbac"
import type { Auth } from "./server.ts"

type Change = { actor: AdminActor; reason: string; correlationId: string }

const notSelf = (actor: AdminActor, userId: string) => {
  if (actor.kind === "staff" && actor.id === userId) throw new ApiError(409, "conflict", "you cannot change your own access; ask another owner")
}

async function assertNotLastOwner(tx: Tx, userId: string) {
  const isOwner = await tx.role.count({ where: { userId, role: "OWNER" } })
  if (!isOwner) return
  const otherActiveOwners = await tx.role.count({ where: { role: "OWNER", userId: { not: userId }, user: { disabledAt: null } } })
  if (otherActiveOwners === 0) throw new ApiError(409, "conflict", "this is the last active owner; add another owner first")
}

export async function createStaffUser(authInstance: Auth, database: Db, input: { email: string; password: string; role: StaffRole; name?: string } & Change) {
  const context = await authInstance.$context
  const { minPasswordLength, maxPasswordLength } = context.password.config
  if (input.password.length < minPasswordLength || input.password.length > maxPasswordLength) {
    throw new ApiError(400, "invalid_request", `Password must be ${minPasswordLength} to ${maxPasswordLength} characters`)
  }
  const hash = await context.password.hash(input.password)
  const email = input.email.trim().toLowerCase()
  return database.$transaction(async tx => {
    const user = await tx.user.upsert({ where: { email }, update: {}, create: { email, name: input.name ?? "" } })
    const credential = await tx.account.findFirst({ where: { userId: user.id, providerId: "credential" } })
    if (credential) await tx.account.update({ where: { id: credential.id }, data: { password: hash } })
    else await tx.account.create({ data: { userId: user.id, accountId: user.id, providerId: "credential", password: hash } })
    await tx.role.upsert({
      where: { userId_role: { userId: user.id, role: input.role } },
      update: {},
      create: { userId: user.id, role: input.role, grantedById: input.actor.kind === "staff" ? input.actor.id : null },
    })
    await recordAdminEvent(tx, { action: "staff.created", actor: input.actor, entity: { type: "user", id: user.id }, reason: input.reason, after: { role: input.role }, correlationId: input.correlationId })
    return user
  })
}

export async function grantRole(database: Db, input: { userId: string; role: StaffRole } & Change) {
  notSelf(input.actor, input.userId)
  return database.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { disabledAt: true } })
    if (!user) throw new ApiError(404, "not_found", "not found")
    if (user.disabledAt) throw new ApiError(409, "conflict", "reactivate the user before granting roles")
    const existing = await tx.role.findUnique({ where: { userId_role: { userId: input.userId, role: input.role } } })
    if (existing) return "unchanged" as const
    await tx.role.create({ data: { userId: input.userId, role: input.role, grantedById: input.actor.kind === "staff" ? input.actor.id : null } })
    await recordAdminEvent(tx, { action: "staff.role_granted", actor: input.actor, entity: { type: "user", id: input.userId }, reason: input.reason, after: { role: input.role }, correlationId: input.correlationId })
    return "granted" as const
  })
}

/** Removing a role also ends the user's sessions, so lost access takes effect immediately. */
export async function revokeRole(database: Db, input: { userId: string; role: StaffRole } & Change) {
  notSelf(input.actor, input.userId)
  return database.$transaction(async tx => {
    if (input.role === "OWNER") await assertNotLastOwner(tx, input.userId)
    const { count } = await tx.role.deleteMany({ where: { userId: input.userId, role: input.role } })
    if (count === 0) return "unchanged" as const
    const sessions = await tx.authSession.deleteMany({ where: { userId: input.userId } })
    await recordAdminEvent(tx, {
      action: "staff.role_revoked",
      actor: input.actor,
      entity: { type: "user", id: input.userId },
      reason: input.reason,
      before: { role: input.role },
      after: { sessionsRevoked: sessions.count },
      correlationId: input.correlationId,
    })
    return "revoked" as const
  })
}

export async function deactivateUser(database: Db, input: { userId: string } & Change) {
  notSelf(input.actor, input.userId)
  return database.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { disabledAt: true } })
    if (!user) throw new ApiError(404, "not_found", "not found")
    if (user.disabledAt) return "unchanged" as const
    await assertNotLastOwner(tx, input.userId)
    await tx.user.update({ where: { id: input.userId }, data: { disabledAt: new Date() } })
    const sessions = await tx.authSession.deleteMany({ where: { userId: input.userId } })
    await recordAdminEvent(tx, { action: "staff.deactivated", actor: input.actor, entity: { type: "user", id: input.userId }, reason: input.reason, after: { sessionsRevoked: sessions.count }, correlationId: input.correlationId })
    return "deactivated" as const
  })
}

/** Ends every signed-in session of a user. Returns how many were revoked. */
export async function revokeAllSessions(database: Db, input: { userId: string } & Change) {
  return database.$transaction(async tx => {
    const { count } = await tx.authSession.deleteMany({ where: { userId: input.userId } })
    await recordAdminEvent(tx, { action: "staff.sessions_revoked", actor: input.actor, entity: { type: "user", id: input.userId }, reason: input.reason, after: { sessionsRevoked: count }, correlationId: input.correlationId })
    return count
  })
}
