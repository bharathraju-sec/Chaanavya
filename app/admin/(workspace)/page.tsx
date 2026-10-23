import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { EmptyState, PageHeader, Section } from "@/components/admin/blocks"
import { AuditTable } from "@/components/admin/audit-table"
import { ADMIN_SECTIONS } from "@/lib/admin/navigation"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

// The overview shows only what is true today. There are no sales figures because no orders are
// taken through Chaanavya yet; nothing here is a sample, an estimate or a placeholder number.
export default async function AdminOverview() {
  const { staff, base } = await requireAdminPage("orders.read")
  const mine = ADMIN_SECTIONS.filter(s => s.path && staff.capabilities.has(s.capability))
  const working = mine.filter(s => !s.planned)
  const planned = mine.filter(s => s.planned)
  const recent = staff.capabilities.has("audit.read") ? await recentActivity() : null

  return (
    <>
      <PageHeader eyebrow="Admin" title="Overview" />

      <Section title="Sales">
        <EmptyState title="No sales figures yet">
          <p>Online checkout is not open yet, so this workspace has no sales, order or stock figures to show. They will appear here once Chaanavya checkout is live.</p>
        </EmptyState>
      </Section>

      {working.length > 0 && (
        <Section title="Available now">
          <ul className="divide-y divide-line border-y border-line">
            {working.map(s => (
              <li key={s.path}>
                <Link href={`${base}${s.path}`} className="flex min-h-14 items-center justify-between gap-4 text-ink transition-colors hover:text-terra">
                  <span className="font-serif text-xl">{s.label}</span>
                  <ArrowRight className="size-4" strokeWidth={1.5} aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {planned.length > 0 && (
        <Section title="Not built yet">
          <p className="mb-4 text-sm text-muted-foreground">These sections are in the menu so the layout is settled, but they hold no data until their modules exist.</p>
          <p className="text-ink">{planned.map(s => s.label).join(", ")}</p>
        </Section>
      )}

      {recent && (
        <Section title="Recent activity" action={<Link href={`${base}/audit`} className="label-caps text-ink underline underline-offset-[7px] hover:text-terra">Audit trail</Link>}>
          {recent.length ? <AuditTable events={recent} compact /> : <EmptyState title="No activity recorded yet">Sign-ins, role changes and other sensitive actions will be listed here.</EmptyState>}
        </Section>
      )}
    </>
  )
}

async function recentActivity() {
  const result = await apiGet("/api/admin/audit?limit=5", "/api/v1/admin/audit")
  if (!result.ok) throw new Error(`audit lookup failed with ${result.status}`)
  return result.data.data
}
