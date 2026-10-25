// Guest sessions (Stage 05): an anonymous shopper's handle on their own cart and orders.
// The cookie holds 32 random bytes; the database stores only their SHA-256 hash, so a database
// leak does not hand out working guest cookies. A guest session is never an identity: it cannot
// hold a role, sign in, or reach staff routes.
import { createHash, randomBytes } from "node:crypto"
import type { Db } from "../db/client.ts"

export const GUEST_COOKIE = "chaanavya_guest"
export const GUEST_TTL_SECONDS = 30 * 24 * 60 * 60
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export const hashGuestToken = (token: string) => createHash("sha256").update(token).digest("hex")

export type GuestSessionRef = { id: string; expiresAt: Date }

export async function createGuestSession(db: Db): Promise<{ session: GuestSessionRef; token: string }> {
  const token = randomBytes(32).toString("base64url")
  const session = await db.guestSession.create({
    data: { tokenHash: hashGuestToken(token), expiresAt: new Date(Date.now() + GUEST_TTL_SECONDS * 1000) },
    select: { id: true, expiresAt: true },
  })
  return { session, token }
}

/** The raw value of the guest cookie, as sent (not decoded), or null when there is none. */
const rawGuestCookie = (headers: Headers) => {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === GUEST_COOKIE) return rest.join("=")
  }
  return null
}

/**
 * Reads the guest token from a Cookie header. Malformed values are ignored. The shop's own tokens
 * are base64url, which never needs percent-decoding, so the value is checked as sent: a value such
 * as `%`, `%ZZ`, a truncated token or any other text is simply not a token (pre-Stage-12 fix F04:
 * decoding it used to throw), and it is never looked up in the database.
 */
export function readGuestToken(headers: Headers): string | null {
  const value = rawGuestCookie(headers)
  return value !== null && TOKEN.test(value) ? value : null
}

/** True when the request carries a guest cookie at all, valid or not (so a bad one can be cleared). */
export const hasGuestCookie = (headers: Headers) => rawGuestCookie(headers) !== null

/** The live guest session for this request, or null if missing, unknown, expired or revoked. */
export async function findGuestSession(db: Db, headers: Headers): Promise<GuestSessionRef | null> {
  const token = readGuestToken(headers)
  if (!token) return null
  const session = await db.guestSession.findUnique({ where: { tokenHash: hashGuestToken(token) }, select: { id: true, expiresAt: true, revokedAt: true } })
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null
  return { id: session.id, expiresAt: session.expiresAt }
}

export const guestCookieHeader = (token: string, secure: boolean) =>
  `${GUEST_COOKIE}=${token}; Path=/; Max-Age=${GUEST_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`

export async function revokeGuestSession(db: Db, id: string) {
  await db.guestSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } })
}
