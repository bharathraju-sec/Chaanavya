// Chaanavya API entry point (Stage 07). Refuses to start outside development when its configuration
// is incomplete (names of the problems are logged, never values).
import { twoFactorWaived } from "@chaanavya/shared/auth/two-factor-waiver"
import { checkEnv } from "@chaanavya/shared/config/env"
import { createLogger } from "@chaanavya/shared/observability/logger"
import { createApiApp } from "./app.ts"

const logger = createLogger({ base: { service: "api" } })
const report = checkEnv(process.env, { service: "api" })
for (const warning of report.warnings) logger.warn("api.config_warning", { setting: warning.name, problem: warning.problem })
if (!report.ok) {
  for (const error of report.errors) logger.error("api.config_error", { setting: error.name, problem: error.problem })
  if (report.environment !== "development") process.exit(1)
}

// A loud reminder that staff sign-in is not protected by two-factor (development only, temporary).
if (twoFactorWaived(process.env)) logger.warn("api.two_factor_waived", { setting: "ADMIN_TWO_FACTOR", note: "staff can use the admin with a password alone; remove the setting before real staff accounts exist" })

const app = await createApiApp()
const port = Number(process.env.API_PORT?.trim() || 4000)
await app.listen(port, "0.0.0.0")
logger.info("api.started", { port, environment: report.environment })
