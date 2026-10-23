import Link from "next/link"
import { AccessDenied, EmptyState, fieldClass, PageHeader } from "@/components/admin/blocks"
import { when } from "@/components/admin/inventory/shared"
import { Button } from "@/components/ui/button"
import { apiGet, problemOf } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// Inventory (Stage 09): stock per SKU from the ledger. A SKU is for sale only once an approved
// stocktake has counted it and its product is live; nothing here is sample data.
export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { allowed, base } = await requireAdminPage("inventory.read")
  if (!allowed) return <AccessDenied section="Inventory" />
  const params = await searchParams
  const query = new URLSearchParams({ limit: "50" })
  for (const name of ["search", "cursor"]) {
    const value = one(params[name])
    if (value) query.set(name, value)
  }
  if (one(params.view) === "low") query.set("lowStock", "1")
  if (one(params.view) === "uncounted") query.set("uncounted", "1")
  const answer = await apiGet(`/api/admin/inventory/stock?${query}`, "/api/v1/admin/inventory/stock")
  if (!answer.ok && answer.status !== 400) throw new Error(`stock list failed with ${answer.status}`)
  const rows = answer.ok ? answer.data.data : []
  const nextCursor = answer.ok ? answer.data.page.nextCursor : null
  const keep = (extra: Record<string, string>) => {
    const next = new URLSearchParams()
    for (const name of ["search", "view"]) {
      const value = one(params[name])
      if (value) next.set(name, value)
    }
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    return `${base}/inventory?${next}`
  }

  return (
    <>
      <PageHeader eyebrow="Stock" title="Inventory">
        <p>Units on hand, held for orders awaiting payment, allocated to paid orders, and available to sell. Every change is a ledger entry with a reason. A SKU goes on sale only after an approved stocktake has counted it.</p>
      </PageHeader>

      <div className="mb-8 flex flex-wrap gap-3">
        <Button asChild variant="quiet">
          <Link href={`${base}/inventory/stocktakes`}>Stocktakes</Link>
        </Button>
      </div>

      <form method="get" action={`${base}/inventory`} className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-2 text-sm lg:col-span-2">
          <span className="label-caps text-ink">Search</span>
          <input name="search" defaultValue={one(params.search) ?? ""} placeholder="SKU or product name" maxLength={100} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="label-caps text-ink">Show</span>
          <select name="view" defaultValue={one(params.view) ?? ""} className={fieldClass}>
            <option value="">All SKUs</option>
            <option value="low">Low stock</option>
            <option value="uncounted">Never counted</option>
          </select>
        </label>
        <div className="flex gap-3 sm:col-span-2 lg:col-span-3">
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
          <Button asChild variant="link" size="sm">
            <Link href={`${base}/inventory`}>Clear</Link>
          </Button>
        </div>
      </form>

      {!answer.ok && <p role="alert" className="mb-6 text-sm text-destructive">{problemOf(answer)}</p>}

      {rows.length === 0 ? (
        <EmptyState title="No SKUs here">
          <p>SKUs appear when products get variants in Products. Stock is then received, or counted in a stocktake.</p>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line bg-card">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                <th scope="col" className="px-4 py-3 font-semibold">SKU</th>
                <th scope="col" className="px-4 py-3 font-semibold">Product</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">On hand</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Held</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Allocated</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Available</th>
                <th scope="col" className="px-4 py-3 font-semibold">For sale</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(s => (
                <tr key={s.variantId} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-3">
                    <Link href={`${base}/inventory/${s.variantId}`} className="font-mono text-xs text-ink underline-offset-4 hover:text-terra hover:underline">
                      {s.sku}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {s.product.title}
                    <span className="block text-xs text-muted-foreground">{s.variantTitle}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-ink tabular-nums">{s.onHand}</td>
                  <td className="px-4 py-3 text-right text-ink tabular-nums">{s.reserved}</td>
                  <td className="px-4 py-3 text-right text-ink tabular-nums">{s.allocated}</td>
                  <td className="px-4 py-3 text-right text-ink tabular-nums">
                    {s.available}
                    {s.lowStock && <span className="block text-xs text-terra">Low stock</span>}
                  </td>
                  <td className="px-4 py-3 text-ink">{s.sellable ? "Yes" : !s.lastCountedAt ? "Not counted yet" : s.product.status !== "active" ? "Product not live" : "Sold out"}{s.lastCountedAt && <span className="block text-xs text-muted-foreground">Counted {when(s.lastCountedAt)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div className="mt-6">
          <Button asChild variant="outline" size="sm">
            <Link href={keep({ cursor: nextCursor })}>More SKUs</Link>
          </Button>
        </div>
      )}
    </>
  )
}
