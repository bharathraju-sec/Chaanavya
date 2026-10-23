import Link from "next/link"
import { notFound } from "next/navigation"
import { AccessDenied, PageHeader } from "@/components/admin/blocks"
import { SOURCE_LABEL, STOCKTAKE_STATUS, when } from "@/components/admin/inventory/shared"
import { StocktakeEditor } from "@/components/admin/inventory/stocktake-editor"
import { Button } from "@/components/ui/button"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function StocktakePage({ params }: { params: Promise<{ id: string }> }) {
  const { allowed, base, staff } = await requireAdminPage("inventory.read")
  if (!allowed) return <AccessDenied section="Stocktakes" />
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const answer = await apiGet(`/api/admin/inventory/stocktakes/${id}`, "/api/v1/admin/inventory/stocktakes/{id}")
  if (!answer.ok && answer.status === 404) notFound()
  if (!answer.ok) throw new Error(`stocktake failed with ${answer.status}`)
  const s = answer.data.data
  return (
    <>
      <PageHeader eyebrow={`Stocktake / ${STOCKTAKE_STATUS[s.status] ?? s.status}`} title={s.note || `Stocktake of ${when(s.createdAt)}`}>
        <p>
          {SOURCE_LABEL[s.source] ?? s.source}. Started {when(s.createdAt)}.{s.approvedAt ? ` Approved ${when(s.approvedAt)} and signed by ${s.signedName}.` : ""}
        </p>
      </PageHeader>
      <div className="mb-8 flex flex-wrap gap-3">
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/inventory/stocktakes`}>All stocktakes</Link>
        </Button>
      </div>
      <StocktakeEditor key={s.etag} initial={s} can={{ count: staff.capabilities.has("inventory.adjust"), approve: staff.capabilities.has("inventory.approve") }} />
    </>
  )
}
