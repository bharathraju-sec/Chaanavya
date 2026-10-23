// Audit trail query shared by GET /api/admin/audit and the audit page (Stage 06).
import { ApiError, decodeCursor, pageOf, UUID } from "./api.ts"
import type { Db } from "../db/client.ts"

const isCursor = (v: unknown): v is { at: string; id: string } => typeof (v as { at?: unknown })?.at === "string" && typeof (v as { id?: unknown })?.id === "string"
const WORD = /^[a-z_.:-]{1,64}$/i
const ENTITY_ID = /^[A-Za-z0-9_.:-]{1,100}$/

export type AuditFilters = { action?: string; entityType?: string; entityId?: string; actorId?: string }

export function parseAuditFilters(get: (name: string) => string | null | undefined): AuditFilters {
  const read = (name: keyof AuditFilters, pattern: RegExp) => {
    const value = get(name)?.trim()
    if (!value) return undefined
    if (!pattern.test(value)) throw new ApiError(400, "invalid_request", `${name} is malformed`, { [name]: "malformed" })
    return value
  }
  return { action: read("action", WORD), entityType: read("entityType", WORD), entityId: read("entityId", ENTITY_ID), actorId: read("actorId", UUID) }
}

export async function listAudit(db: Db, { filters, limit, cursor }: { filters: AuditFilters; limit: number; cursor: string | null }) {
  const after = decodeCursor(cursor, isCursor)
  const rows = await db.auditEvent.findMany({
    where: { ...filters, ...(after && { OR: [{ occurredAt: { lt: new Date(after.at) } }, { occurredAt: new Date(after.at), id: { lt: after.id } }] }) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })
  return pageOf(rows, limit, row => ({ at: row.occurredAt.toISOString(), id: row.id }))
}
