"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Upload } from "lucide-react"
import { fieldClass, Section } from "@/components/admin/blocks"
import { send, type Problem } from "@/components/admin/catalogue/shared"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import type { Stocktake } from "./shared"

/** Start a count by hand, or from a count file (owner CSV or an old Shopify export as reference). */
export function StartStocktake({ base }: { base: string }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [source, setSource] = useState<"owner_csv" | "shopify_export">("owner_csv")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  async function start() {
    setBusy(true)
    const result = await send<Stocktake>("POST", "/api/admin/inventory/stocktakes", { body: { note } })
    if (result.ok) router.push(`${base}/inventory/stocktakes/${result.data.id}`)
    else {
      setProblem(result.problem)
      setBusy(false)
    }
  }

  async function importFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    if (file.size > 1024 * 1024) {
      setProblem({ status: 413, message: "The file is larger than 1 MB. Split it into smaller files.", fields: {} })
      return
    }
    setBusy(true)
    const result = await send<Stocktake>("POST", "/api/admin/inventory/stocktakes/import", { body: { csv: await file.text(), source, note: note || file.name } })
    if (result.ok) router.push(`${base}/inventory/stocktakes/${result.data.id}`)
    else {
      setProblem({ ...result.problem, message: Object.values(result.problem.fields)[0] ? `${result.problem.message} (${Object.keys(result.problem.fields)[0]})` : result.problem.message })
      setBusy(false)
    }
  }

  return (
    <Section title="Start a stocktake">
      <div className="grid max-w-3xl gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="st-note">Note</Label>
          <input id="st-note" value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="October count, main shelf and back room" className={fieldClass} />
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Count SKU by SKU on the next page.</p>
          <div>
            <Button onClick={start} disabled={busy}>
              Count by hand
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Label htmlFor="st-source">Or import a count file</Label>
          <select id="st-source" value={source} onChange={e => setSource(e.target.value as typeof source)} className={fieldClass}>
            <option value="owner_csv">Count file: sku, counted (note, shopify_quantity optional)</option>
            <option value="shopify_export">Old Shopify products export (quantities as reference only)</option>
          </select>
          <input id="st-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={e => importFile(e.target.files)} disabled={busy} />
          <div>
            <Button asChild variant="outline">
              <label htmlFor="st-file" className="cursor-pointer">
                <Upload strokeWidth={1.5} aria-hidden />
                Choose CSV
              </label>
            </Button>
          </div>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {problem.message}
          </p>
        )}
      </div>
    </Section>
  )
}
