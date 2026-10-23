import { AccessDenied, PageHeader } from "@/components/admin/blocks"
import { NewProductForm } from "@/components/admin/catalogue/new-product-form"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

export default async function NewProductPage() {
  const { allowed, base } = await requireAdminPage("catalogue.write")
  if (!allowed) return <AccessDenied section="New product" />
  const collections = await apiGet("/api/admin/catalogue/collections", "/api/v1/admin/catalogue/collections")
  if (!collections.ok) throw new Error(`collections failed with ${collections.status}`)
  return (
    <>
      <PageHeader eyebrow="Catalogue" title="New product">
        <p>Start with the name and where it belongs. Variants, prices and photos come next; the product stays a draft until an owner publishes it.</p>
      </PageHeader>
      <NewProductForm base={base} collections={collections.data.data.map(({ id, title, handle }) => ({ id, title, handle }))} />
    </>
  )
}
