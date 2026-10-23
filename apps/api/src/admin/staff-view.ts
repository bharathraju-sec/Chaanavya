// Read model for staff management (Stage 06). The ETag covers exactly what role and deactivation
// changes depend on, so a stale screen cannot overwrite another owner's change.
import { ApiError, etagOf } from "./api.ts"
import type { Db } from "../db/client.ts"

const SELECT = { id: true, email: true, name: true, twoFactorEnabled: true, disabledAt: true, createdAt: true, roles: { select: { role: true } } } as const

type Row = { id: string; email: string; name: string; twoFactorEnabled: boolean; disabledAt: Date | null; createdAt: Date; roles: { role: string }[] }

export type StaffView = { id: string; email: string; name: string; roles: string[]; twoFactorEnabled: boolean; disabledAt: string | null; createdAt: string; etag: string }

export function toStaffView(row: Row): StaffView {
  const roles = row.roles.map(r => r.role).sort()
  const disabledAt = row.disabledAt?.toISOString() ?? null
  return { id: row.id, email: row.email, name: row.name, roles, twoFactorEnabled: row.twoFactorEnabled, disabledAt, createdAt: row.createdAt.toISOString(), etag: etagOf({ id: row.id, roles, disabledAt }) }
}

export async function loadStaff(db: Db, userId: string): Promise<StaffView> {
  const row = await db.user.findUnique({ where: { id: userId }, select: SELECT })
  if (!row) throw new ApiError(404, "not_found", "not found")
  return toStaffView(row)
}

/** Users who hold or held a staff role (disabled users stay listed so they can be audited). */
export async function listStaff(db: Db, { limit, afterId }: { limit: number; afterId: string | null }) {
  const rows = await db.user.findMany({
    where: { OR: [{ roles: { some: {} } }, { disabledAt: { not: null }, accounts: { some: { providerId: "credential" } } }], ...(afterId && { id: { gt: afterId } }) },
    orderBy: { id: "asc" },
    take: limit + 1,
    select: SELECT,
  })
  return rows.map(toStaffView)
}
