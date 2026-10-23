// Request body reader for the API's own routes (Better Auth reads its own). Keeps the raw text so the
// validators in src/admin/api.ts can apply exactly the Stage 06 rules (415 for a wrong content type,
// 413 for an oversized body, 400 for bad JSON). Stops buffering past READ_LIMIT without failing the
// request here; readJson then answers 413.
import type { NextFunction, Request, Response } from "express"
import type { ApiRequest } from "./context.ts"

export const READ_LIMIT = 64 * 1024
/** Catalogue CSV imports (Stage 08) and stocktakes (Stage 09) send up to 1 MB of CSV inside JSON, which escaping can grow. */
export const IMPORT_READ_LIMIT = 3 * 1024 * 1024
/** Stocktake lines and count files (Stage 09) can list thousands of SKUs. */
const LARGE_BODIES = [/^\/api\/v1\/admin\/catalogue\/import\//, /^\/api\/v1\/admin\/inventory\/stocktakes(\/import|\/[0-9a-f-]{36}\/lines)$/]
const limitFor = (path: string) => (LARGE_BODIES.some(p => p.test(path)) ? IMPORT_READ_LIMIT : READ_LIMIT)

export function readBody(req: Request, _res: Response, next: NextFunction) {
  const context = (req as ApiRequest).chaanavya
  context.body = { contentType: String(req.headers["content-type"] ?? ""), text: "" }
  if (req.method === "GET" || req.method === "HEAD") return next()
  const limit = limitFor(req.path)
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  req.on("data", (chunk: Buffer) => {
    size += chunk.length
    if (size > limit) tooLarge = true
    else chunks.push(chunk)
  })
  req.on("end", () => {
    context.body.text = tooLarge ? null : Buffer.concat(chunks).toString("utf8")
    next()
  })
  req.on("error", next)
}
