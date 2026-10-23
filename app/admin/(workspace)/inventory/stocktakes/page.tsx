import Link from "next/link"
import { AccessDenied, EmptyState, PageHeader, Section } from "@/components/admin/blocks"
import { SOURCE_LABEL, STOCKTAKE_STATUS, when } from "@/components/admin/inventory/shared"
import { StartStocktake } from "@/components/admin/inventory/start-stocktake"
import { Button } from "@/components/ui/button"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

export default async function StocktakesPage() {
  const { allowed, base, staff } = await requireAdminPage("inventory.read")
  if (!allowed) return <AccessDenied section="Stocktakes" />
  const answer = await apiGet("/api/admin/inventory/stocktakes?limit=50", "/api/v1/admin/inventory/stocktakes")
  if (!answer.ok) throw new Error(`stocktakes failed with ${answer.status}`)
  const list = answer.data.data

  return (
    <>
      <PageHeader eyebrow="Stock" title="Stocktakes">
        <p>A stocktake is a physical count. When an owner approves it, every difference from the books is accepted line by line, the report is signed, and the counted SKUs can be sold. Imported files only ever start a draft; an old Shopify export is a reference, never a count.</p>
      </PageHeader>
      <div className="mb-8">
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/inventory`}>All stock</Link>
        </Button>
      </div>
      {staff.capabilities.has("inventory.adjust") && <StartStocktake base={base} />}
      <Section title="All stocktakes">
        {list.length === 0 ? (
          <EmptyState title="No stocktakes yet">The first approved stocktake is what puts real stock on sale.</EmptyState>
        ) : (
          <div className="overflow-x-auto border border-line bg-card">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th scope="col" className="px-4 py-3 font-semibold">Started (IST)</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Source</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">SKUs</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Signed by</th>
                </tr>
              </thead>
              <tbody>
                {list.map(s => (
                  <tr key={s.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3">
                      <Link href={`${base}/inventory/stocktakes/${s.id}`} className="text-ink underline-offset-4 hover:text-terra hover:underline">
                        {when(s.createdAt)}
                      </Link>
                      {s.note && <span className="block text-xs text-muted-foreground">{s.note}</span>}
                    </td>
                    <td className="px-4 py-3 text-ink">{STOCKTAKE_STATUS[s.status] ?? s.status}</td>
                    <td className="px-4 py-3 text-ink">{SOURCE_LABEL[s.source] ?? s.source}</td>
                    <td className="px-4 py-3 text-right text-ink tabular-nums">{s.lines}</td>
                    <td className="px-4 py-3 text-ink">{s.signedName ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  )
}
