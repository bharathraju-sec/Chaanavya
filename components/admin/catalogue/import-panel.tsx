"use client"

import { useState } from "react"
import Link from "next/link"
import { Upload } from "lucide-react"
import { Section } from "@/components/admin/blocks"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatPaise, send, type ImportPreview, type Problem } from "./shared"

const MAX_BYTES = 1024 * 1024

export function ImportPanel({ base }: { base: string }) {
  const [csv, setCsv] = useState<string | null>(null)
  const [fileName, setFileName] = useState("")
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [reason, setReason] = useState("")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function choose(files: FileList | null) {
    const file = files?.[0]
    setPreview(null)
    setDone(null)
    setProblem(null)
    if (!file) return
    if (file.size > MAX_BYTES) {
      setProblem({ status: 413, message: "The file is larger than 1 MB. Split it into smaller files.", fields: {} })
      return
    }
    setFileName(file.name)
    const text = await file.text()
    setCsv(text)
    setBusy(true)
    const result = await send<ImportPreview>("POST", "/api/admin/catalogue/import/preview", { body: { csv: text } })
    if (result.ok) setPreview(result.data)
    else setProblem(result.problem)
    setBusy(false)
  }

  async function commit() {
    if (!csv || !preview?.token) return
    setBusy(true)
    const result = await send<ImportPreview["summary"]>("POST", "/api/admin/catalogue/import/commit", { body: { csv, token: preview.token, reason: reason.trim() } })
    if (result.ok) {
      setDone(`Saved ${result.data.productsCreated} new and ${result.data.productsUpdated} updated drafts (${result.data.variantsCreated + result.data.variantsUpdated} variants).`)
      setPreview(null)
      setCsv(null)
    } else {
      setProblem(result.problem.status === 409 ? { ...result.problem, message: "The products in this file changed after the check. Choose the file again to check it once more." } : result.problem)
    }
    setBusy(false)
  }

  return (
    <>
      <Section title="1. Choose a file">
        <input id="csv-input" type="file" accept=".csv,text/csv" className="sr-only" onChange={e => choose(e.target.files)} />
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild variant="outline">
            <label htmlFor="csv-input" className="cursor-pointer">
              <Upload strokeWidth={1.5} aria-hidden />
              Choose CSV
            </label>
          </Button>
          {fileName && <p className="text-sm text-ink">{fileName}</p>}
          {busy && <p role="status" className="text-sm text-ink">Checking</p>}
        </div>
        {problem && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {problem.message}
          </p>
        )}
        {done && (
          <p role="status" className="mt-4 text-sm text-ink">
            {done}{" "}
            <Link href={`${base}/products?status=draft`} className="underline underline-offset-4 hover:text-terra">
              See the drafts
            </Link>
          </p>
        )}
      </Section>

      {preview && (
        <Section title="2. Check the result">
          {preview.errors.length > 0 ? (
            <>
              <p className="mb-4 text-sm text-destructive">The file has {preview.errors.length} {preview.errors.length === 1 ? "problem" : "problems"}. Nothing will be saved until they are fixed.</p>
              <div className="overflow-x-auto border border-line bg-card">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                      <th scope="col" className="px-4 py-3 font-semibold">Row</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Column</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.map((e, i) => (
                      <tr key={i} className="border-b border-line last:border-b-0">
                        <td className="px-4 py-3 text-ink">{e.row}</td>
                        <td className="px-4 py-3 font-mono text-xs text-ink">{e.field}</td>
                        <td className="px-4 py-3 text-ink">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-ink">
                {preview.summary.productsCreated} new and {preview.summary.productsUpdated} updated drafts; {preview.summary.variantsCreated} new and {preview.summary.variantsUpdated} updated variants. Stock is not changed.
              </p>
              <div className="overflow-x-auto border border-line bg-card">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                      <th scope="col" className="px-4 py-3 font-semibold">Product</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Variant</th>
                      <th scope="col" className="px-4 py-3 font-semibold">SKU</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.products.flatMap(p =>
                      p.variants.map(v => (
                        <tr key={`${p.handle}:${v.sku}`} className="border-b border-line last:border-b-0">
                          <td className="px-4 py-3 text-ink">
                            {p.title} <span className="text-xs text-muted-foreground">{p.action === "create" ? "new" : "update"}</span>
                          </td>
                          <td className="px-4 py-3 text-ink">{v.title}</td>
                          <td className="px-4 py-3 font-mono text-xs text-ink">{v.sku}</td>
                          <td className="px-4 py-3 text-ink">{v.beforePricePaise && v.beforePricePaise !== v.pricePaise ? `${formatPaise(v.beforePricePaise)} to ${formatPaise(v.pricePaise)}` : formatPaise(v.pricePaise)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-8 flex max-w-2xl flex-col gap-2">
                <Label htmlFor="import-reason">Reason (kept in the audit trail)</Label>
                <Textarea id="import-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Autumn range from the owner's sheet" className="min-h-20 rounded-none border-line-strong bg-paper" />
              </div>
              <div className="mt-6">
                <Button onClick={commit} disabled={busy || reason.trim().length < 3}>
                  Save as drafts
                </Button>
              </div>
            </>
          )}
        </Section>
      )}
    </>
  )
}
