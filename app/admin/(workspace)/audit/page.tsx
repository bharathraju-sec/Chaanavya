import Link from "next/link"
import { AccessDenied, EmptyState, fieldClass, PageHeader } from "@/components/admin/blocks"
import { AuditTable } from "@/components/admin/audit-table"
import { Button } from "@/components/ui/button"
import { apiGet, problemOf } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const FILTERS = ["action", "entityType", "entityId", "actorId"]

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { allowed, base } = await requireAdminPage("audit.read")
  if (!allowed) return <AccessDenied section="Audit trail" />
  const params = await searchParams
  // The API validates the filters and cursor; a 400 is shown next to the form.
  const query = new URLSearchParams({ limit: "50" })
  for (const name of [...FILTERS, "cursor"]) {
    const value = one(params[name])
    if (value) query.set(name, value)
  }
  const answer = await apiGet(`/api/admin/audit?${query}`, "/api/v1/admin/audit")
  if (!answer.ok && answer.status !== 400) throw new Error(`audit lookup failed with ${answer.status}`)
  const result = answer.ok ? { items: answer.data.data, nextCursor: answer.data.page.nextCursor } : null
  const problem = answer.ok ? null : problemOf(answer)
  const keep = (extra: Record<string, string>) => {
    const query = new URLSearchParams()
    for (const name of FILTERS) {
      const value = one(params[name])
      if (value) query.set(name, value)
    }
    for (const [k, v] of Object.entries(extra)) query.set(k, v)
    return `${base}/audit?${query}`
  }

  return (
    <>
      <PageHeader eyebrow="Accountability" title="Audit trail">
        <p>Every sensitive action: sign-ins, role and access changes, and later price, stock, refund and courier actions. Entries cannot be edited or deleted.</p>
      </PageHeader>

      <form method="get" action={`${base}/audit`} className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["action", "Action", "staff.role_granted"],
          ["entityType", "Record type", "user"],
          ["entityId", "Record ID", ""],
          ["actorId", "Done by (user ID)", ""],
        ].map(([name, label, hint]) => (
          <label key={name} className="flex flex-col gap-2 text-sm">
            <span className="label-caps text-ink">{label}</span>
            <input name={name} defaultValue={one(params[name]) ?? ""} placeholder={hint} className={fieldClass} />
          </label>
        ))}
        <div className="flex gap-3 sm:col-span-2 lg:col-span-4">
          <Button type="submit" variant="outline" size="sm">Filter</Button>
          <Button asChild variant="link" size="sm">
            <Link href={`${base}/audit`}>Clear</Link>
          </Button>
        </div>
      </form>

      {problem && <p role="alert" className="mb-6 text-sm text-destructive">{problem}</p>}
      {result && (result.items.length ? <AuditTable events={result.items} /> : <EmptyState title="No matching entries">Try fewer filters.</EmptyState>)}
      {result?.nextCursor && (
        <div className="mt-6">
          <Button asChild variant="outline" size="sm">
            <Link href={keep({ cursor: result.nextCursor })}>Older entries</Link>
          </Button>
        </div>
      )}
    </>
  )
}
