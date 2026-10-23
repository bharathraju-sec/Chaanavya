// Validates the current process environment against packages/shared/src/config/env.ts.
// Usage: npm run check:env -- [--target development|staging|production] [--service web|api|worker]
// With --service, only that service's settings are checked (and the web host is refused database
// and sign-in secrets outside development). Prints setting names, set/missing status and problems
// only. Exits 1 when any error is found.
import { APP_ENVIRONMENTS, checkEnv, SERVICES } from "../packages/shared/src/config/env.ts"

const index = process.argv.indexOf("--target")
const target = index > -1 ? process.argv[index + 1] : undefined
if (target && !APP_ENVIRONMENTS.includes(target)) {
  console.error(`Unknown --target "${target}". Use ${APP_ENVIRONMENTS.join(", ")}.`)
  process.exit(2)
}

const serviceIndex = process.argv.indexOf("--service")
const service = serviceIndex > -1 ? process.argv[serviceIndex + 1] : undefined
if (service && !SERVICES.includes(service)) {
  console.error(`Unknown --service "${service}". Use ${SERVICES.join(", ")}.`)
  process.exit(2)
}

const report = checkEnv(process.env, { target, service })
console.log(`Environment: ${report.environment}${service ? ` (${service})` : ""}`)
for (const s of report.settings) console.log(`  ${s.status === "set" ? "set    " : "missing"}  ${s.name}${s.required ? "  (required)" : ""}${s.kind === "secret" ? "  [secret]" : ""}`)
for (const w of report.warnings) console.warn(`WARN  ${w.name}: ${w.problem}`)
for (const e of report.errors) console.error(`ERROR ${e.name}: ${e.problem}`)
console.log(report.ok ? "Environment check passed." : `Environment check failed with ${report.errors.length} error(s).`)
process.exit(report.ok ? 0 : 1)
