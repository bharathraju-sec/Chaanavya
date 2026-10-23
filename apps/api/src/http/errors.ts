// One exception filter for the whole API (Stage 07). Response bodies match the Stage 05/06 formats
// exactly, so clients and tests see no change after the move from Next.js:
//   AuthError (guards)       { "error": "<code>" }
//   ApiError (admin rules)   { "error": { "code", "message", "fields"? } }
//   unknown route            { "error": "not_found" }
//   rate limit               { "error": "rate_limited" } with Retry-After
//   anything else            { "error": "internal_error" }, logged with the correlation ID
// Every error response is Cache-Control: no-store.
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common"
import { ThrottlerException } from "@nestjs/throttler"
import type { Response } from "express"
import { createLogger } from "@chaanavya/shared/observability/logger"
import { ApiError } from "../admin/api.ts"
import { AuthError } from "../auth/session.ts"
import type { ApiRequest } from "./context.ts"

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp()
    const res = http.getResponse<Response>()
    const req = http.getRequest<ApiRequest>()
    res.setHeader("cache-control", "no-store")
    if (exception instanceof AuthError) return res.status(exception.status).json({ error: exception.code })
    if (exception instanceof ApiError) return res.status(exception.status).json(exception.toBody())
    if (exception instanceof ThrottlerException) {
      res.setHeader("retry-after", "60")
      return res.status(429).json({ error: "rate_limited" })
    }
    if (exception instanceof HttpException && exception.getStatus() === 404) return res.status(404).json({ error: "not_found" })
    if (exception instanceof HttpException && exception.getStatus() < 500) return res.status(exception.getStatus()).json({ error: "invalid_request" })
    createLogger({ correlationId: req.chaanavya?.correlationId }).error("route.failed", { path: req.path, method: req.method, error: exception })
    return res.status(500).json({ error: "internal_error" })
  }
}
