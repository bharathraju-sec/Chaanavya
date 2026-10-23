// Per-IP request limit for the API's own routes (Stage 07). Sign-in endpoints keep Better Auth's
// stricter database-backed limits (src/auth/server.ts). This one is held in memory per instance, so
// with N instances the effective limit is N times higher; a shared store comes with Stage 19.
import { Injectable } from "@nestjs/common"
import { ThrottlerGuard } from "@nestjs/throttler"
import type { ApiRequest } from "./context.ts"

export const API_RATE_LIMIT = { ttl: 60_000, limit: 600 }

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return (req as unknown as ApiRequest).chaanavya?.clientIp ?? "unknown"
  }
}
