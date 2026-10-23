// Express middleware that runs before everything else in the API (Stage 07, decision 032):
//   1. correlation ID: reuses the caller's x-correlation-id or creates one, and echoes it back;
//   2. internal caller: every route except the health probes needs the web host's API_INTERNAL_KEY,
//      compared in constant time. Browsers never hold the key, so they cannot call the API directly,
//      and the forwarded headers in src/http/context.ts can be trusted;
//   3. baseline security headers.
import { timingSafeEqual } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import { readEnv, resolveEnvironment } from "@chaanavya/shared/config/env"
import { correlationIdFrom, createLogger } from "@chaanavya/shared/observability/logger"
import { forwardedClientIp, forwardedHost, headersOf, type ApiRequest } from "./context.ts"

export const INTERNAL_KEY_HEADER = "x-chaanavya-internal-key"
/** Development only, when API_INTERNAL_KEY is unset (like the compose database's password, not a secret). */
export const DEVELOPMENT_INTERNAL_KEY = "development-only-internal-key-not-a-secret"
const OPEN_PATHS = new Set(["/health", "/ready"])

/** The key the API expects. Outside development it must be configured (checked at start-up too). */
export function expectedInternalKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = readEnv(env, "API_INTERNAL_KEY")
  if (key) return key
  if (resolveEnvironment(env) === "development") return DEVELOPMENT_INTERNAL_KEY
  throw new Error("API_INTERNAL_KEY must be set outside development")
}

function sameKey(sent: string, expected: string) {
  const a = Buffer.from(sent)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const correlationId = correlationIdFrom(headersOf(req))
  ;(req as ApiRequest).chaanavya = { correlationId, host: forwardedHost(req), clientIp: forwardedClientIp(req), body: { contentType: "", text: "" } }
  res.setHeader("x-correlation-id", correlationId)
  res.setHeader("x-content-type-options", "nosniff")
  res.setHeader("x-frame-options", "DENY")
  res.setHeader("referrer-policy", "no-referrer")
  next()
}

export function internalCallerOnly(req: Request, res: Response, next: NextFunction) {
  if (OPEN_PATHS.has(req.path)) return next()
  const sent = req.headers[INTERNAL_KEY_HEADER]
  if (typeof sent === "string" && sameKey(sent, expectedInternalKey())) return next()
  createLogger({ correlationId: (req as ApiRequest).chaanavya.correlationId }).warn("api.internal_key_rejected", { path: req.path, method: req.method })
  res.setHeader("cache-control", "no-store")
  res.status(401).json({ error: "unauthenticated" })
}
