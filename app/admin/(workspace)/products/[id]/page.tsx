import { notFound } from "next/navigation"
import { AccessDenied } from "@/components/admin/blocks"
import { ProductEditor } from "@/components/admin/catalogue/product-editor"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { allowed, base, staff } = await requireAdminPage("catalogue.read")
  if (!allowed) return <AccessDenied section="Products" />
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const [product, collections] = await Promise.all([apiGet(`/api/admin/catalogue/products/${id}`, "/api/v1/admin/catalogue/products/{id}"), apiGet("/api/admin/catalogue/collections", "/api/v1/admin/catalogue/collections")])
  if (!product.ok && product.status === 404) notFound()
  if (!product.ok) throw new Error(`product failed with ${product.status}`)
  if (!collections.ok) throw new Error(`collections failed with ${collections.status}`)
  return (
    <ProductEditor
      key={product.data.data.etag}
      base={base}
      initial={product.data.data}
      collections={collections.data.data.map(({ id, title, handle }) => ({ id, title, handle }))}
      can={{ write: staff.capabilities.has("catalogue.write"), publish: staff.capabilities.has("catalogue.publish") }}
    />
  )
}
