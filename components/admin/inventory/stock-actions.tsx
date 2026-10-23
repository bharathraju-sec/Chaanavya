"use client"

// Receive, correct and write off stock for one SKU (Stage 09). Each action sends the record's ETag
// and a fresh Idempotency-Key, so a stale page cannot overwrite someone else's change and a double
// click is applied once. The API writes the ledger row and the audit event with the change.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { fieldClass, Section } from "@/components/admin/blocks"
import { send, type Problem } from "@/components/admin/catalogue/shared"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { actionKey, ADJUST_REASONS, WRITE_OFF_REASONS, type Stock } from "./shared"

type Action = "receive" | "adjust" | "write-off" | "threshold"

const LABELS: Record<Action, string> = { receive: "Receive stock", adjust: "Correct the count", "write-off": "Write off", threshold: "Low-stock notice" }

export function StockActions({ initial }: { initial: Stock }) {
  const router = useRouter()
  const [stock, setStock] = useState(initial)
  const [action, setAction] = useState<Action>("receive")
  const [quantity, setQuantity] = useState("")
  const [direction, setDirection] = useState<"up" | "down">("down")
  const [reasonCode, setReasonCode] = useState("")
  const [reason, setReason] = useState("")
  const [threshold, setThreshold] = useState(initial.lowStockThreshold?.toString() ?? "")
  const [key, setKey] = useState(actionKey)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const n = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : NaN
  const ready =
    action === "threshold"
      ? threshold.trim() === "" || /^\d+$/.test(threshold.trim())
      : Number.isInteger(n) && n > 0 && reason.trim().length >= 3 && (action === "receive" || reasonCode !== "")

  function choose(next: Action) {
    setAction(next)
    setReasonCode("")
    setProblem(null)
    setDone(null)
  }

  async function apply(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setDone(null)
    const path = `/api/admin/inventory/stock/${stock.variantId}`
    const result =
      action === "threshold"
        ? await send<Stock>("PATCH", path, { body: { lowStockThreshold: threshold.trim() === "" ? null : Number(threshold) }, etag: stock.etag })
        : await sendWithKey(action, path, n)
    if (result.ok) {
      setStock(result.data)
      setProblem(null)
      setQuantity("")
      setReason("")
      setKey(actionKey())
      setDone(`${LABELS[action]}: saved. On hand is now ${result.data.onHand}, available ${result.data.available}.`)
      router.refresh()
    } else {
      setProblem(result.problem.status === 412 ? { ...result.problem, message: "The stock changed after you opened this page (an order hold or another person). The numbers above are now current; check them and try again." } : result.problem)
      if (result.problem.status === 412) {
        // Reload this SKU's numbers and ETag here, so the message stays on screen.
        const fresh = await send<Stock>("GET", `/api/admin/inventory/stock/${stock.variantId}`)
        if (fresh.ok) setStock(fresh.data)
        router.refresh()
      }
    }
    setBusy(false)
  }

  async function sendWithKey(kind: Exclude<Action, "threshold">, path: string, units: number) {
    const body =
      kind === "receive"
        ? { quantity: units, reason: reason.trim() }
        : kind === "adjust"
          ? { delta: direction === "up" ? units : -units, reasonCode, reason: reason.trim() }
          : { quantity: units, reasonCode, reason: reason.trim() }
    const res = await fetch(`${path}/${kind}`, { method: "POST", headers: { "content-type": "application/json", "if-match": stock.etag, "idempotency-key": key }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    if (res.ok) return { ok: true as const, data: json.data as Stock, etag: res.headers.get("etag") }
    return { ok: false as const, problem: { status: res.status, message: json?.error?.message ?? (res.status === 403 ? "Your role cannot change stock." : "The change could not be saved."), fields: json?.error?.fields ?? {} } }
  }

  return (
    <Section title="Change stock">
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Choose a change">
        {(Object.keys(LABELS) as Action[]).map(a => (
          <Button key={a} size="sm" variant={a === action ? "outline" : "quiet"} aria-pressed={a === action} onClick={() => choose(a)}>
            {LABELS[a]}
          </Button>
        ))}
      </div>
      <form onSubmit={apply} className="grid max-w-3xl gap-5 sm:grid-cols-2" noValidate>
        {action === "threshold" ? (
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="threshold">Show a low-stock notice when available is at or below</Label>
            <input id="threshold" value={threshold} onChange={e => setThreshold(e.target.value)} inputMode="numeric" placeholder="Empty: no notice" className={fieldClass} />
          </div>
        ) : (
          <>
            {action === "adjust" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="direction">Direction</Label>
                <select id="direction" value={direction} onChange={e => setDirection(e.target.value as "up" | "down")} className={fieldClass}>
                  <option value="down">Fewer than recorded</option>
                  <option value="up">More than recorded</option>
                </select>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="quantity">Units</Label>
              <input id="quantity" value={quantity} onChange={e => setQuantity(e.target.value)} inputMode="numeric" aria-invalid={Boolean(problem?.fields.quantity || problem?.fields.delta)} className={fieldClass} />
            </div>
            {action !== "receive" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="reason-code">Why</Label>
                <select id="reason-code" value={reasonCode} onChange={e => setReasonCode(e.target.value)} className={fieldClass}>
                  <option value="">Choose</option>
                  {(action === "adjust" ? ADJUST_REASONS : WRITE_OFF_REASONS).map(r => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="stock-reason">{action === "receive" ? "Delivery or reference (kept in the audit trail)" : "Details (kept in the audit trail)"}</Label>
              <input id="stock-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder={action === "receive" ? "Delivery from the weaver, invoice 1042" : "Two torn at the hem during steaming"} className={fieldClass} />
            </div>
          </>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {problem.message}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-ink sm:col-span-2">
            {done}
          </p>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy || !ready}>
            {busy ? "Saving" : LABELS[action]}
          </Button>
        </div>
      </form>
    </Section>
  )
}
