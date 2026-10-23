// Better Auth's endpoints in the API (Stage 07): /api/auth/* (sign-in codes, staff password and
// TOTP, sign-out, sessions). Mounted as Express middleware ahead of the API's body reader, because
// Better Auth reads the request body itself. The web host forwards the browser's /api/auth/*
// requests here unchanged (same path), with the browser's Origin, cookies and IP; Better Auth
// applies its own origin check and database-backed rate limits.
import { toNodeHandler } from "better-auth/node"
import type { NextFunction, Request, Response } from "express"
import { AUTH_BASE_PATH, auth } from "./server.ts"

let handler: ReturnType<typeof toNodeHandler> | undefined

export function betterAuthRoutes(req: Request, res: Response, next: NextFunction) {
  if (req.path !== AUTH_BASE_PATH && !req.path.startsWith(`${AUTH_BASE_PATH}/`)) return next()
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("allow", "GET, POST")
    res.status(405).end()
    return
  }
  handler ??= toNodeHandler(auth())
  handler(req, res).catch(next)
}
