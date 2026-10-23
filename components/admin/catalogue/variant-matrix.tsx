"use client"

// Variant matrix (Stage 08): up to three options (Size, Colour, Volume, Material), one row per
// combination with its SKU, price and tax details. Saved as a whole in one transaction: the API
// refuses duplicate SKUs or combinations and then writes nothing. Stock is not edited here.
import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { fieldClass, Section } from "@/components/admin/blocks"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import type { EditorContext } from "./product-editor"
import { formatPaise, OPTION_NAMES, paiseToRupees, rupeesToPaise, send, type AdminProduct, type Problem } from "./shared"

type OptionRow = { name: string; values: string }
type Row = { key: string; id: string | null; options: Record<string, string>; sku: string; price: string; compareAt: string; taxCategory: string; hsnCode: string; weight: string; mediaId: string }

const cell = "h-11 w-full min-w-24 border border-line-strong bg-paper px-2.5 text-sm outline-none focus:border-ink"
let rowCounter = 0
const newKey = () => `row-${++rowCounter}`

const comboKey = (options: Record<string, string>) =>
  Object.entries(options)
    .map(([k, v]) => `${k.toLowerCase()}=${v.trim().toLowerCase()}`)
    .sort()
    .join("|")

function rowsOf(product: AdminProduct): Row[] {
  return product.variants.map(v => ({
    key: newKey(),
    id: v.id,
    options: v.options,
    sku: v.sku,
    price: paiseToRupees(v.pricePaise),
    compareAt: paiseToRupees(v.compareAtPricePaise),
    taxCategory: v.taxCategory === "unassigned" ? "" : v.taxCategory,
    hsnCode: v.hsnCode ?? "",
    weight: v.weightGrams?.toString() ?? "",
    mediaId: v.mediaId ?? "",
  }))
}

const valuesOf = (text: string) => [...new Map(text.split(",").map(v => v.trim()).filter(Boolean).map(v => [v.toLowerCase(), v])).values()]

export function VariantMatrix({ context }: { context: EditorContext }) {
  const { product, editable, reason, apply } = context
  const [options, setOptions] = useState<OptionRow[]>(product.options.map(o => ({ name: o.name, values: o.values.join(", ") })))
  const [rows, setRows] = useState<Row[]>(() => rowsOf(product))
  const [problem, setProblem] = useState<Problem | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const defined = options.filter(o => o.name && valuesOf(o.values).length)
  const photos = product.media.filter(m => m.status !== "rejected")

  /** Adds a row for every combination that has none; keeps existing rows and their prices. */
  function buildCombinations() {
    const combos = defined.reduce<Record<string, string>[]>((acc, o) => acc.flatMap(partial => valuesOf(o.values).map(v => ({ ...partial, [o.name]: v }))), [{}])
    const have = new Set(rows.map(r => comboKey(r.options)))
    const added = combos.filter(c => !have.has(comboKey(c))).map(c => ({ key: newKey(), id: null, options: c, sku: "", price: "", compareAt: "", taxCategory: rows[0]?.taxCategory ?? "", hsnCode: rows[0]?.hsnCode ?? "", weight: "", mediaId: "" }))
    setRows([...rows, ...added])
  }

  const update = (key: string, patch: Partial<Row>) => setRows(rows.map(r => (r.key === key ? { ...r, ...patch } : r)))

  async function save() {
    setSaved(false)
    const errors: Record<string, string> = {}
    const variants = rows.map(r => {
      const pricePaise = rupeesToPaise(r.price)
      const compareAtPricePaise = r.compareAt.trim() ? rupeesToPaise(r.compareAt) : null
      if (pricePaise === null) errors[`${r.key}.price`] = "Enter a price in rupees, like 2499 or 2499.50"
      if (r.compareAt.trim() && compareAtPricePaise === null) errors[`${r.key}.compareAt`] = "Enter an amount in rupees"
      return {
        ...(r.id && { id: r.id }),
        options: Object.fromEntries(defined.map(o => [o.name, r.options[o.name] ?? ""])),
        sku: r.sku,
        pricePaise: pricePaise ?? "",
        compareAtPricePaise,
        taxCategory: r.taxCategory.trim() || null,
        hsnCode: r.hsnCode.trim() || null,
        weightGrams: r.weight.trim() ? Number(r.weight) : null,
        mediaId: r.mediaId || null,
      }
    })
    setRowErrors(errors)
    if (Object.keys(errors).length) {
      setProblem({ status: 400, message: "Check the highlighted prices.", fields: {} })
      return
    }
    setBusy(true)
    const body = { options: defined.map(o => ({ name: o.name, values: valuesOf(o.values) })), variants, ...(reason.trim() && { reason: reason.trim() }) }
    const result = await send<AdminProduct>("PUT", `/api/admin/catalogue/products/${product.id}/variants`, { body, etag: product.etag })
    const failure = apply(result)
    setProblem(failure)
    if (failure) {
      // Map "variants.2.sku" onto the row that was sent at index 2.
      const mapped: Record<string, string> = {}
      for (const [field, message] of Object.entries(failure.fields)) {
        const match = /^variants\.(\d+)\.(\w+)$/.exec(field)
        if (match && rows[Number(match[1])]) mapped[`${rows[Number(match[1])].key}.${match[2] === "pricePaise" ? "price" : match[2] === "compareAtPricePaise" ? "compareAt" : match[2]}`] = message
      }
      setRowErrors(mapped)
    } else if (result.ok) {
      setRows(rowsOf(result.data))
      setOptions(result.data.options.map(o => ({ name: o.name, values: o.values.join(", ") })))
      setSaved(true)
    }
    setBusy(false)
  }

  const err = (row: Row, field: string) => rowErrors[`${row.key}.${field}`]

  return (
    <Section title="Variants and prices">
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">Prices are in rupees and include GST. Each combination of options needs its own SKU. Stock is managed in Inventory and is never changed here.</p>
      <fieldset disabled={!editable || busy} className="flex flex-col gap-8">
        <div className="flex max-w-3xl flex-col gap-4">
          {options.map((o, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`opt-name-${i}`}>Option {i + 1}</Label>
                <select id={`opt-name-${i}`} value={o.name} onChange={e => setOptions(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={fieldClass}>
                  {OPTION_NAMES.filter(n => n === o.name || !options.some(x => x.name === n)).map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`opt-values-${i}`}>Values, separated by commas</Label>
                <input id={`opt-values-${i}`} value={o.values} onChange={e => setOptions(options.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} placeholder={o.name === "Size" ? "XS, S, M, L, XL" : o.name === "Volume" ? "50 ml, 100 ml" : ""} className={fieldClass} />
              </div>
              <Button variant="ghost" size="icon" aria-label={`Remove option ${o.name}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                <Trash2 strokeWidth={1.5} aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            {options.length < 3 && (
              <Button variant="quiet" size="sm" onClick={() => setOptions([...options, { name: OPTION_NAMES.find(n => !options.some(o => o.name === n)) ?? "Size", values: "" }])}>
                <Plus strokeWidth={1.5} aria-hidden />
                Add option
              </Button>
            )}
            <Button variant="quiet" size="sm" onClick={buildCombinations} disabled={defined.length === 0 && rows.length > 0}>
              {defined.length ? "Add missing combinations" : "Add a single variant"}
            </Button>
          </div>
        </div>

        {rows.length > 0 && (
          <div className="overflow-x-auto border border-line bg-card">
            <table className="w-full min-w-[980px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th scope="col" className="px-3 py-3 font-semibold">Variant</th>
                  <th scope="col" className="px-3 py-3 font-semibold">SKU</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Price (₹)</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Compare at (₹)</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Tax category</th>
                  <th scope="col" className="px-3 py-3 font-semibold">HSN</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Weight (g)</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Photo</th>
                  <th scope="col" className="px-3 py-3">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const label = defined.map(o => r.options[o.name]).filter(Boolean).join(" / ") || "Default"
                  const stale = defined.some(o => !valuesOf(o.values).some(v => v.toLowerCase() === (r.options[o.name] ?? "").toLowerCase()))
                  return (
                    <tr key={r.key} className="border-b border-line align-top last:border-b-0">
                      <td className="px-3 py-2 text-ink">
                        {label}
                        {stale && <span className="block text-xs text-destructive">Not in the options above; remove it or add the value back.</span>}
                        {!r.id && <span className="block text-xs text-muted-foreground">New</span>}
                      </td>
                      {(["sku", "price", "compareAt", "taxCategory", "hsnCode", "weight"] as const).map(field => (
                        <td key={field} className="px-3 py-2">
                          <input
                            aria-label={`${field === "compareAt" ? "Compare-at price" : field === "taxCategory" ? "Tax category" : field === "hsnCode" ? "HSN code" : field === "sku" ? "SKU" : field.charAt(0).toUpperCase() + field.slice(1)} for ${label}`}
                            value={r[field]}
                            onChange={e => update(r.key, { [field]: field === "sku" ? e.target.value.toUpperCase() : e.target.value })}
                            inputMode={field === "price" || field === "compareAt" ? "decimal" : field === "weight" || field === "hsnCode" ? "numeric" : undefined}
                            placeholder={field === "taxCategory" ? "apparel" : ""}
                            aria-invalid={Boolean(err(r, field))}
                            className={`${cell} ${field === "sku" ? "font-mono" : ""}`}
                          />
                          {err(r, field) && <p className="mt-1 max-w-48 text-xs text-destructive">{err(r, field)}</p>}
                          {field === "price" && !err(r, field) && rupeesToPaise(r.price) && <p className="mt-1 text-xs text-muted-foreground">{formatPaise(rupeesToPaise(r.price))}</p>}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <select aria-label={`Photo for ${label}`} value={r.mediaId} onChange={e => update(r.key, { mediaId: e.target.value })} className={cell}>
                          <option value="">Product photos</option>
                          {photos.map((m, i) => (
                            <option key={m.id} value={m.id}>
                              Photo {i + 1}
                              {m.status === "pending" ? " (waiting)" : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <Button variant="ghost" size="icon" aria-label={`Remove ${label}`} onClick={() => setRows(rows.filter(x => x.key !== r.key))}>
                          <Trash2 strokeWidth={1.5} aria-hidden />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>
      {problem && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {problem.message}
        </p>
      )}
      {saved && (
        <p role="status" className="mt-4 text-sm text-ink">
          Variants saved. Removed variants are archived, not deleted, because orders may refer to them.
        </p>
      )}
      {editable && (
        <div className="mt-6">
          <Button onClick={save} disabled={busy || rows.length === 0}>
            {busy ? "Saving" : "Save variants"}
          </Button>
        </div>
      )}
    </Section>
  )
}
