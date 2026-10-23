// Minimal RFC 4180 CSV (Stage 08 import and export): quoted fields, doubled quotes, CRLF or LF.
// Exported cells that a spreadsheet would run as a formula (=, +, -, @, tab, return) get a leading
// apostrophe, which the import removes again.

const FORMULA = /^[=+\-@\t\r]/

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      if (ch === '"') {
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === "") {
      quoted = true
      i++
      continue
    }
    if (ch === ",") {
      row.push(field)
      field = ""
      i++
      continue
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (quoted) throw new Error("a quoted field is not closed")
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => r.some(cell => cell.trim() !== "")).map(r => r.map(unguard))
}

const unguard = (cell: string) => (cell.startsWith("'") && FORMULA.test(cell.slice(1)) ? cell.slice(1) : cell)

const cellOf = (value: string) => {
  const guarded = FORMULA.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

export const toCsv = (rows: string[][]) => `${rows.map(r => r.map(cellOf).join(",")).join("\r\n")}\r\n`
