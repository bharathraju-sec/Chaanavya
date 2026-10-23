// Probes for the hosting platform (Stage 07). No internal key needed; they reveal nothing.
//   GET /health  liveness: the process answers
//   GET /ready   readiness: the database answers (503 otherwise), so a load balancer only sends
//                traffic to instances that can serve it
import { Controller, Get, Res } from "@nestjs/common"
import { ApiExcludeController } from "@nestjs/swagger"
import type { Response } from "express"
import { db } from "../db/client.ts"
import { Access } from "../http/access.ts"

@ApiExcludeController()
@Controller()
export class HealthController {
  @Get("health")
  @Access.probe()
  health() {
    return { status: "ok" }
  }

  @Get("ready")
  @Access.probe()
  async ready(@Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    try {
      await db().$queryRaw`SELECT 1`
      return { status: "ready", database: "ok" }
    } catch {
      res.status(503)
      return { status: "unavailable", database: "unreachable" }
    }
  }
}
