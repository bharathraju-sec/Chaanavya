import Link from "next/link"
import { notFound } from "next/navigation"
import { AccessDenied, EmptyState, PageHeader, Section } from "@/components/admin/blocks"
import { MOVEMENT_LABEL, when } from "@/components/admin/inventory/shared"
import { StockActions } from "@/components/admin/inventory/stock-actions"
import { Button } from "@/components/ui/button"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function StockPage({ params, searchParams }: { params: Promise<{ variantId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { allowed, base, staff } = await requireAdminPage("inventory.read")
  if (!allowed) return <AccessDenied section="Inventory" />
  const { variantId } = await params
  if (!UUID.test(variantId)) notFound()
  const cursor = one((await searchParams).cursor)
  const [stock, movements] = await Promise.all([
    apiGet(`/api/admin/inventory/stock/${variantId}`, "/api/v1/admin/inventory/stock/{variantId}"),
    apiGet(`/api/admin/inventory/stock/${variantId}/movements?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, "/api/v1/admin/inventory/stock/{variantId}/movements"),
  ])
  if (!stock.ok && stock.status === 404) notFound()
  if (!stock.ok) throw new Error(`stock failed with ${stock.status}`)
  if (!movements.ok) throw new Error(`movements failed with ${movements.status}`)
  const s = stock.data.data
  const history = movements.data.data

  return (
    <>
      <PageHeader eyebrow={`Stock / ${s.sku}`} title={s.product.title}>
        <p>
          {s.variantTitle}. {s.sellable ? "For sale." : !s.lastCountedAt ? "Not for sale until an approved stocktake counts it." : s.product.status !== "active" ? "Not for sale: the product is not live." : "Sold out."}
          {s.lastCountedAt ? ` Last counted ${when(s.lastCountedAt)}.` : ""}
        </p>
      </PageHeader>

      <div className="mb-8 flex flex-wrap gap-3">
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/inventory`}>All stock</Link>
        </Button>
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/products/${s.product.id}`}>Product</Link>
        </Button>
      </div>

      <dl className="mb-12 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
        {[
          ["On hand", s.onHand],
          ["Held for orders", s.reserved],
          ["Allocated", s.allocated],
          ["Available", s.available],
        ].map(([label, value]) => (
          <div key={label} className="bg-card px-5 py-4">
            <dt className="label-caps text-muted-foreground">{label}</dt>
            <dd className="mt-2 font-serif text-3xl text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {staff.capabilities.has("inventory.adjust") && !s.archived && <StockActions initial={s} />}

      <Section title="History">
        {history.length === 0 ? (
          <EmptyState title="No movements yet">Receipts, corrections, write-offs, holds and stocktake corrections will be listed here.</EmptyState>
        ) : (
          <div className="overflow-x-auto border border-line bg-card">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th scope="col" className="px-4 py-3 font-semibold">When (IST)</th>
                  <th scope="col" className="px-4 py-3 font-semibold">What</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Units</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">On hand after</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Reason</th>
                  <th scope="col" className="px-4 py-3 font-semibold">By</th>
                </tr>
              </thead>
              <tbody>
                {history.map(m => (
                  <tr key={m.id} className="border-b border-line align-top last:border-b-0">
                    <td className="px-4 py-3 whitespace-nowrap text-ink">{when(m.occurredAt)}</td>
                    <td className="px-4 py-3 text-ink">{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                    <td className="px-4 py-3 text-right text-ink tabular-nums">{m.quantity > 0 && m.type !== "release" ? `+${m.quantity}` : m.type === "release" ? `-${m.quantity}` : m.quantity}</td>
                    <td className="px-4 py-3 text-right text-ink tabular-nums">{m.onHandAfter ?? ""}</td>
                    <td className="px-4 py-3 text-ink">
                      {m.reason}
                      {m.reasonCode && <span className="block text-xs text-muted-foreground">{m.reasonCode.replaceAll("_", " ")}</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{m.actorKind === "system" ? "System" : m.actorId ? `${m.actorId.slice(0, 8)}...` : m.actorKind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {movements.data.page.nextCursor && (
          <div className="mt-6">
            <Button asChild variant="outline" size="sm">
              <Link href={`${base}/inventory/${variantId}?cursor=${encodeURIComponent(movements.data.page.nextCursor)}`}>Older entries</Link>
            </Button>
          </div>
        )}
      </Section>
    </>
  )
}
