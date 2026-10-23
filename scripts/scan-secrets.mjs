// Looks for secrets in build output and logs (Stage 03, CHV-S03-003).
// Usage: npm run scan:secrets -- [--env-file .env.local] [--process-env] <path> [<path> ...]
//
// Two checks: (1) the actual values of every secret setting (packages/shared/src/config/env.ts `isSecretName`)
// taken from the env file and/or the process environment, and (2) well-known credential patterns.
// Output names the setting or pattern and the file, never the value. Exits 1 on any finding.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { isSecretName } from "../packages/shared/src/config/env.ts"

const args = process.argv.slice(2)
const envFiles = []
const paths = []
let useProcessEnv = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--env-file") envFiles.push(args[++i])
  else if (args[i] === "--process-env") useProcessEnv = true
  else paths.push(args[i])
}
if (paths.length === 0) {
  console.error("Usage: npm run scan:secrets -- [--env-file <file>] [--process-env] <path> [<path> ...]")
  process.exit(2)
}

function parseEnvFile(file) {
  const values = {}
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2")
  }
  return values
}

const env = { ...(useProcessEnv ? process.env : {}) }
for (const file of envFiles) if (existsSync(file)) Object.assign(env, parseEnvFile(file))

// Values shorter than 8 characters are too generic to search for without false alarms.
const secrets = Object.entries(env)
  .filter(([name, value]) => isSecretName(name) && typeof value === "string" && value.trim().length >= 8)
  .map(([name, value]) => ({ name, needle: Buffer.from(value.trim()) }))

const PATTERNS = [
  ["Razorpay live key", /rzp_live_[A-Za-z0-9]{8,}/],
  ["Razorpay test key", /rzp_test_[A-Za-z0-9]{8,}/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  // The header followed by key material; the bare header also appears in libraries that parse PEM (jose).
  // Separator: a real line break, or an escaped "\n" / "\r" as it appears inside bundled JS strings.
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----(?:\\[nr]|\s)+[A-Za-z0-9+/]{40}/],
  ["Postgres URL with password", /postgres(?:ql)?:\/\/[^:\s/"']+:(?!chaanavya_dev_only@)[^@\s/"']{6,}@/],
]

const SKIP_DIRS = new Set(["node_modules", ".git"])
const files = []
function walk(path) {
  if (!existsSync(path)) return
  const stat = statSync(path)
  if (stat.isFile()) files.push(path)
  else if (stat.isDirectory()) for (const entry of readdirSync(path)) if (!SKIP_DIRS.has(entry)) walk(join(path, entry))
}
paths.forEach(walk)

const findings = []
for (const file of files) {
  const buffer = readFileSync(file)
  for (const { name, needle } of secrets) if (buffer.includes(needle)) findings.push(`${name} value found in ${file}`)
  const text = buffer.toString("latin1")
  for (const [label, pattern] of PATTERNS) if (pattern.test(text)) findings.push(`${label} pattern found in ${file}`)
}

console.log(`Scanned ${files.length} files under ${paths.join(", ")} for ${secrets.length} secret values (names: ${secrets.map(s => s.name).join(", ") || "none"}) and ${PATTERNS.length} credential patterns.`)
if (findings.length) {
  for (const finding of findings) console.error(`FOUND ${finding}`)
  process.exit(1)
}
console.log("No secrets found.")
