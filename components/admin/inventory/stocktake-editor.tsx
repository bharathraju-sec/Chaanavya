"use client"

// A stocktake (Stage 09): counting (draft), the reconciliation report (books versus count for every
// SKU, plus listing checks), and the owner's approval: accept each discrepancy, confirm the
// statement, type your name. The API applies the corrections and stores the signed report together.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Plus, Trash2 } from "lucide-react"
import { fieldClass, Section } from "@/components/admin/blocks"
import { formatPaise, send, type Problem } from "@/components/admin/catalogue/shared"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { when, type Stocktake } from "./shared"

type Can = { count: boolean; approve: boolean }
type Line = { key: number; sku: string; counted: string; note: string; reference: number | null }

const cell = "h-11 w-full border border-line-strong bg-paper px-2.5 text-sm outline-none focus:border-ink"
let counter = 0

export function StocktakeEditor({ initial, can }: { initial: Stocktake; can: Can }) {
  const router = useRouter()
  const [s, setS] = useState(initial)
  const [lines, setLines] = useState<Line[]>(initial.report.lines.map(l => ({ key: ++counter, sku: l.sku, counted: String(l.counted), note: l.note, reference: l.reference })))
  const [accepted, setAccepted] = useState<string[]>([])
  const [statement, setStatement] = useState(false)
  const [signedName, setSignedName] = useState("")
  const [reason, setReason] = useState("")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  const base = `/api/admin/inventory/stocktakes/${s.id}`
  /** Sends one change with the stocktake's current ETag (or the one a previous step just returned). */
  async function act(method: string, path: string, body?: unknown, etag = s.etag): Promise<Stocktake | null> {
    setBusy(true)
    const result = await send<Stocktake>(method, `${base}${path}`, { body, etag })
    setBusy(false)
    if (result.ok) {
      setS(result.data)
      setProblem(null)
      return result.data
    }
    setProblem(result.problem.status === 412 ? { ...result.problem, message: "Someone else changed this stocktake after you opened it. Reload the page to see the latest version." } : result.problem)
    return null
  }

  /** Refresh the server-rendered page (heading, list) only after a change succeeded, so errors stay visible. */
  const done = (result: Stocktake | null) => {
    if (result) router.refresh()
    return result
  }

  const invalid = lines.some(l => !l.sku.trim() || !/^\d+$/.test(l.counted.trim()))
  const saveLines = () => act("PUT", "/lines", { lines: lines.map(l => ({ sku: l.sku.trim(), counted: Number(l.counted), note: l.note, reference: l.reference })) })
  const discrepancies = s.report.lines.filter(l => l.difference !== 0)
  const allAccepted = discrepancies.every(l => accepted.includes(l.sku))

  return (
    <>
      {s.status === "draft" && can.count && (
        <Section title="Counts">
          <p className="mb-4 max-w-3xl text-sm text-muted-foreground">Enter what is physically on the shelf for each SKU. Save as you go; submit when counting is finished. Notes explain differences for the approver.</p>
          <div className="overflow-x-auto border border-line bg-card">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th scope="col" className="px-3 py-3 font-semibold">SKU</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Counted</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Reference</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Note</th>
                  <th scope="col" className="px-3 py-3">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2">
                      <input aria-label={`SKU, line ${i + 1}`} value={l.sku} onChange={e => setLines(lines.map(x => (x.key === l.key ? { ...x, sku: e.target.value.toUpperCase() } : x)))} className={`${cell} font-mono`} />
                    </td>
                    <td className="px-3 py-2">
                      <input aria-label={`Counted units, line ${i + 1}`} value={l.counted} onChange={e => setLines(lines.map(x => (x.key === l.key ? { ...x, counted: e.target.value } : x)))} inputMode="numeric" className={cell} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.reference ?? ""}</td>
                    <td className="px-3 py-2">
                      <input aria-label={`Note, line ${i + 1}`} value={l.note} onChange={e => setLines(lines.map(x => (x.key === l.key ? { ...x, note: e.target.value } : x)))} maxLength={500} className={cell} />
                    </td>
                    <td className="px-3 py-2">
                      <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter(x => x.key !== l.key))}>
                        <Trash2 strokeWidth={1.5} aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="quiet" size="sm" onClick={() => setLines([...lines, { key: ++counter, sku: "", counted: "", note: "", reference: null }])}>
              <Plus strokeWidth={1.5} aria-hidden />
              Add SKU
            </Button>
            <Button variant="outline" size="sm" disabled={busy || invalid} onClick={async () => done(await saveLines())}>
              Save counts
            </Button>
            <Button
              size="sm"
              disabled={busy || invalid || lines.length === 0}
              onClick={async () => {
                const saved = await saveLines()
                if (saved) done(await act("POST", "/submit", undefined, saved.etag))
              }}
            >
              Finish counting
            </Button>
          </div>
        </Section>
      )}

      <Section title={s.status === "approved" ? "Signed reconciliation report" : "Reconciliation"}>
        <dl className="mb-6 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {[
            ["SKUs", s.report.totals.skus],
            ["Counted units", s.report.totals.counted],
            ["Units in the books", s.report.totals.books],
            ["Differences", s.report.totals.discrepancies],
            ["Listing checks", s.report.totals.withChecks],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="label-caps text-muted-foreground">{label}</dt>
              <dd className="font-serif text-2xl text-ink tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {s.report.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No SKUs counted yet.</p>
        ) : (
          <div className="overflow-x-auto border border-line bg-card">
            <table className="w-full min-w-[920px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th scope="col" className="px-3 py-3 font-semibold">SKU</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Product</th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">Books</th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">Counted</th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">Difference</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Price</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Checks and notes</th>
                  {s.status === "submitted" && can.approve && <th scope="col" className="px-3 py-3 font-semibold">Accept</th>}
                </tr>
              </thead>
              <tbody>
                {s.report.lines.map(l => (
                  <tr key={l.sku} className="border-b border-line align-top last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs text-ink">{l.sku}</td>
                    <td className="px-3 py-2 text-ink">
                      {l.product}
                      <span className="block text-xs text-muted-foreground">{l.variant}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-ink tabular-nums">{l.books}</td>
                    <td className="px-3 py-2 text-right text-ink tabular-nums">
                      {l.counted}
                      {l.reference !== null && <span className="block text-xs text-muted-foreground">Reference {l.reference}</span>}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${l.difference ? "font-semibold text-terra" : "text-muted-foreground"}`}>{l.difference > 0 ? `+${l.difference}` : l.difference}</td>
                    <td className="px-3 py-2 text-ink">{formatPaise(l.pricePaise)}</td>
                    <td className="px-3 py-2 text-xs text-ink">
                      {l.checks.map(c => (
                        <span key={c} className="block">
                          {c}
                        </span>
                      ))}
                      {l.note && <span className="block text-muted-foreground">Note: {l.note}</span>}
                    </td>
                    {s.status === "submitted" && can.approve && (
                      <td className="px-3 py-2">
                        {l.difference !== 0 && (
                          <label className="flex min-h-11 items-center gap-2 text-xs text-ink">
                            <input type="checkbox" className="size-5 accent-[var(--color-terra)]" checked={accepted.includes(l.sku)} onChange={e => setAccepted(e.target.checked ? [...accepted, l.sku] : accepted.filter(x => x !== l.sku))} />
                            Accept
                          </label>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.status === "approved" && s.report.approval && (
          <p className="mt-6 max-w-3xl border border-line bg-card px-5 py-4 text-sm text-ink">
            Signed by {String((s.report.approval as Record<string, unknown>).signedName ?? s.signedName)} on {when(s.approvedAt)}: {String((s.report.approval as Record<string, unknown>).statement ?? "")}
          </p>
        )}
      </Section>

      {s.status === "submitted" && can.approve && (
        <Section title="Approve and sign">
          <div className="flex max-w-3xl flex-col gap-5">
            <p className="text-sm text-muted-foreground">Approving writes every difference to the ledger as a correction and puts the counted SKUs on sale (for live products). It cannot be undone; a later stocktake corrects it.</p>
            <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
              <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-terra)]" checked={statement} onChange={e => setStatement(e.target.checked)} />
              The counts are a true physical count, and every discrepancy listed was checked and accepted.
            </label>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="signed-name">Your full name (signature)</Label>
                <input id="signed-name" value={signedName} onChange={e => setSignedName(e.target.value)} maxLength={120} autoComplete="name" className={fieldClass} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="approve-reason">Reason (kept in the audit trail)</Label>
                <input id="approve-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Quarterly count" className={fieldClass} />
              </div>
            </div>
            {!allAccepted && <p className="text-sm text-ink">Accept each of the {discrepancies.length} differences above to approve.</p>}
            <div>
              <Button disabled={busy || !statement || signedName.trim().length < 3 || reason.trim().length < 3 || !allAccepted} onClick={async () => done(await act("POST", "/approve", { signedName: signedName.trim(), acceptedSkus: accepted, statement, reason: reason.trim() }))}>
                Approve and sign
              </Button>
            </div>
          </div>
        </Section>
      )}

      {problem && (
        <div role="alert" className="mb-8 text-sm text-destructive">
          <p>{problem.message}</p>
          {Object.values(problem.fields).length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {Object.entries(problem.fields).map(([field, message]) => (
                <li key={field}>
                  {field.replace(/^accept\./, "")}: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(s.status === "draft" || s.status === "submitted") && can.count && <CancelStocktake onCancel={async r => Boolean(done(await act("POST", "/cancel", { reason: r })))} busy={busy} />}
    </>
  )
}

function CancelStocktake({ onCancel, busy }: { onCancel: (reason: string) => Promise<boolean>; busy: boolean }) {
  const [reason, setReason] = useState("")
  return (
    <Section title="Cancel">
      <div className="flex max-w-3xl flex-wrap items-end gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <Label htmlFor="cancel-reason">Reason</Label>
          <input id="cancel-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Started by mistake" className={fieldClass} />
        </div>
        <Button variant="quiet" disabled={busy || reason.trim().length < 3} onClick={() => onCancel(reason.trim())}>
          Cancel stocktake
        </Button>
      </div>
    </Section>
  )
}
