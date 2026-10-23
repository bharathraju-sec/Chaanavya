import Link from "next/link"
import { AccessDenied, PageHeader } from "@/components/admin/blocks"
import { ImportPanel } from "@/components/admin/catalogue/import-panel"
import { Button } from "@/components/ui/button"
import { requireAdminPage } from "@/lib/auth/permissions"

export default async function ImportPage() {
  const { allowed, base } = await requireAdminPage("catalogue.write")
  if (!allowed) return <AccessDenied section="Catalogue import" />
  return (
    <>
      <PageHeader eyebrow="Catalogue" title="Import products">
        <p>Upload a CSV in the export format: one row per variant. You see every error and every change first; nothing is saved until you confirm. Imported products are drafts, stock is never imported, and live products are edited in the product page instead.</p>
      </PageHeader>
      <div className="mb-8 flex flex-wrap gap-3">
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/products`}>All products</Link>
        </Button>
        <Button asChild variant="quiet" size="sm">
          <a href="/api/admin/catalogue/export" download>
            Download the current catalogue as a template
          </a>
        </Button>
      </div>
      <ImportPanel base={base} />
    </>
  )
}
