// Shared patterns for the admin API (Stage 06; served by the NestJS API since Stage 07):
//   - responses: { data, page? } on success, { error: { code, message, fields? } } on failure;
//   - validation: small explicit validators, unknown fields ignored, never trusted for identity;
//   - pagination: opaque cursor + limit (1 to 100);
//   - optimistic concurrency: GET returns an ETag per record, mutations must send it back in
//     If-Match; a missing header is 428, a stale one 412, so two staff cannot overwrite each other.
// The acting staff member always comes from the session (src/auth/session.ts), never from the body.
// Framework-neutral: controllers pass plain values in, and the exception filter (src/http/errors.ts)
// turns ApiError into the response envelope.
import { createHash } from "node:crypto"

// "unavailable": a dependency (such as the payment provider) could not do it now; trying again may work.
export type ApiErrorCode = "invalid_request" | "not_found" | "conflict" | "precondition_required" | "precondition_failed" | "forbidden" | "rate_limited" | "unavailable"

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly fields: Record<string, string> | undefined
  constructor(status: number, code: ApiErrorCode, message: string, fields?: Record<string, string>) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.fields && { fields: this.fields }) } }
  }
}

// ---- pagination ----------------------------------------------------------------------------

export type PageRequest = { limit: number; cursor: string | null }

export function parsePage(query: URLSearchParams, { defaultLimit = 25, maxLimit = 100 } = {}): PageRequest {
  const rawLimit = query.get("limit")
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new ApiError(400, "invalid_request", `limit must be 1 to ${maxLimit}`, { limit: "out of range" })
  const cursor = query.get("cursor")
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new ApiError(400, "invalid_request", "cursor is malformed", { cursor: "malformed" })
  return { limit, cursor }
}

export const encodeCursor = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")

export function decodeCursor<T>(cursor: string | null, check: (value: unknown) => value is T): T | null {
  if (!cursor) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (check(value)) return value
  } catch {
    /* falls through to the error below */
  }
  throw new ApiError(400, "invalid_request", "cursor is malformed", { cursor: "malformed" })
}

/** Takes limit + 1 rows from the caller and returns the page and the next cursor. */
export function pageOf<T>(rows: T[], limit: number, cursorOf: (row: T) => object) {
  const items = rows.slice(0, limit)
  return { items, nextCursor: rows.length > limit ? encodeCursor(cursorOf(items[items.length - 1])) : null }
}

// ---- validation ----------------------------------------------------------------------------

/** A request body as read by src/http/body.ts: the raw text, or null when it exceeded the read limit. */
/** The body as received: its text, and the exact bytes for signature checks (Stage 14.09). Null past the read limit. */
export type RawBody = { contentType: string; text: string | null; bytes?: Buffer | null }

export function readJson(body: RawBody, maxBytes = 8 * 1024): Record<string, unknown> {
  if (!body.contentType.startsWith("application/json")) throw new ApiError(415, "invalid_request", "send application/json")
  const text = body.text
  if (text === null || text.length > maxBytes) throw new ApiError(413, "invalid_request", "request too large")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid_request", "body must be a JSON object")
  return parsed as Record<string, unknown>
}

/** Staff must say why they made a sensitive change; it is stored in the audit trail. */
export function requireReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (reason.length < 3 || reason.length > 500) throw new ApiError(400, "invalid_request", "a reason of 3 to 500 characters is required", { reason: "required" })
  return reason
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T
  throw new ApiError(400, "invalid_request", `${field} must be one of ${allowed.join(", ")}`, { [field]: "invalid" })
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuidParam(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new ApiError(404, "not_found", "not found")
  return value
}

// ---- optimistic concurrency ----------------------------------------------------------------

/** Weak ETag over the fields that a mutation depends on. */
export const etagOf = (state: unknown) => `W/"${createHash("sha256").update(JSON.stringify(state)).digest("base64url").slice(0, 27)}"`

export function assertIfMatch(sent: string | null | undefined, currentEtag: string) {
  if (!sent) throw new ApiError(428, "precondition_required", "If-Match header required: load the record first")
  if (sent !== currentEtag) throw new ApiError(412, "precondition_failed", "the record changed since you loaded it; reload and try again")
}
