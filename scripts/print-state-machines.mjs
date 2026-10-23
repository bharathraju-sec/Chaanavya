// Prints the commerce state machines as Markdown tables, generated from
// packages/contracts/src/modules/state-machines.ts so the document cannot drift from the code.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/print-state-machines.mjs
import { STATE_MACHINES } from "../packages/contracts/src/modules/state-machines.ts"

const lines = []
for (const machine of STATE_MACHINES) {
  lines.push(`### ${machine.name[0].toUpperCase()}${machine.name.slice(1)}`, "")
  lines.push(`States: ${machine.states.map(s => `\`${s}\``).join(", ")}. Initial: \`${machine.initial}\`. Terminal: ${machine.terminal.map(s => `\`${s}\``).join(", ")}.`, "")
  lines.push("| From | To | Precondition | Meaning |", "| --- | --- | --- | --- |")
  for (const t of machine.transitions) lines.push(`| \`${t.from}\` | \`${t.to}\` | \`${t.precondition}\` | ${t.description} |`)
  lines.push("")
}
process.stdout.write(lines.join("\n"))
