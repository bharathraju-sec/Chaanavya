import Link from "next/link"
import { AccessDenied, PageHeader } from "@/components/admin/blocks"
import { CollectionManager } from "@/components/admin/catalogue/collection-manager"
import { Button } from "@/components/ui/button"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

export default async function CollectionsPage() {
  const { allowed, base, staff } = await requireAdminPage("catalogue.read")
  if (!allowed) return <AccessDenied section="Collections" />
  const answer = await apiGet("/api/admin/catalogue/collections", "/api/v1/admin/catalogue/collections")
  if (!answer.ok) throw new Error(`collections failed with ${answer.status}`)
  return (
    <>
      <PageHeader eyebrow="Catalogue" title="Collections">
        <p>The four shop categories keep their web addresses (/dresses, /ethnic-festive, /jewellery, /fragrance). New collections start hidden; an owner decides when shoppers see them.</p>
      </PageHeader>
      <div className="mb-8">
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/products`}>All products</Link>
        </Button>
      </div>
      <CollectionManager initial={answer.data.data} can={{ write: staff.capabilities.has("catalogue.write"), publish: staff.capabilities.has("catalogue.publish") }} />
    </>
  )
}
