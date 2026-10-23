// Endpoint parity check (Stage 07). Compares two PARITY_RECORD runs of the security suite: one
// against the old Next.js route handlers and one against the NestJS API through the web forwarder.
// Each response was normalised when recorded (tests/security/auth/helpers.mjs), so the remaining
// differences are real contract differences: status, Cache-Control, ETag presence or body shape.
//
//   node scripts/parity-diff.mjs <baseline dir> <candidate dir> [--allow <route substring>]...
//
// Exits 1 when a response differs, unless every difference is on an allowed route.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const [baseline, candidate, ...rest] = process.argv.slice(2)
if (!baseline || !candidate) {
  console.error("usage: node scripts/parity-diff.mjs <baseline dir> <candidate dir> [--allow <route>]...")
  process.exit(2)
}
const allowed = rest.flatMap((arg, i) => (rest[i - 1] === "--allow" ? [arg] : []))

const read = (dir, file) => {
  try {
    return readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean)
  } catch {
    return []
  }
}
/** Counts identical normalised responses, so an order change alone is not a difference. */
const tally = lines => lines.reduce((m, line) => m.set(line, (m.get(line) ?? 0) + 1), new Map())

let compared = 0
let identical = 0
const differences = []
const files = [...new Set([...readdirSync(baseline), ...readdirSync(candidate)])].filter(f => f.endsWith(".jsonl")).sort()
for (const file of files) {
  const before = tally(read(baseline, file))
  const after = tally(read(candidate, file))
  for (const [line, count] of before) {
    const matched = Math.min(count, after.get(line) ?? 0)
    compared += count
    identical += matched
    if (count > matched) differences.push({ file, side: "baseline only", entry: JSON.parse(line), times: count - matched })
  }
  for (const [line, count] of after) {
    const extra = count - Math.min(count, before.get(line) ?? 0)
    if (extra > 0) differences.push({ file, side: "candidate only", entry: JSON.parse(line), times: extra })
  }
}

console.log(`${identical} of ${compared} baseline responses are identical in the candidate run.`)
let blocking = 0
for (const d of differences) {
  const ok = allowed.some(route => d.entry.route.includes(route))
  if (!ok) blocking++
  console.log(`${ok ? "ALLOWED " : "DIFF    "} ${d.file} ${d.side} x${d.times}: ${d.entry.method} ${d.entry.route} ${d.entry.status} cache=${d.entry.cacheControl} etag=${d.entry.etag} ${JSON.stringify(d.entry.body).slice(0, 300)}`)
}
console.log(blocking ? `${blocking} unexplained difference(s).` : "No unexplained differences.")
process.exit(blocking ? 1 : 0)
