import Link from "next/link"
import { Plus } from "lucide-react"
import { AccessDenied, EmptyState, fieldClass, PageHeader } from "@/components/admin/blocks"
import { formatPaise, STATUS_LABEL } from "@/components/admin/catalogue/shared"
import { Button } from "@/components/ui/button"
import { apiGet, problemOf } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// Products (Stage 08): every product the shop has, drafts included, from the API. Nothing here is
// sample data: an empty list means no products have been created yet.
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { allowed, base, staff } = await requireAdminPage("catalogue.read")
  if (!allowed) return <AccessDenied section="Products" />
  const params = await searchParams
  const query = new URLSearchParams({ limit: "25" })
  for (const name of ["search", "status", "collectionId", "cursor"]) {
    const value = one(params[name])
    if (value) query.set(name, value)
  }
  const [answer, collections] = await Promise.all([apiGet(`/api/admin/catalogue/products?${query}`, "/api/v1/admin/catalogue/products"), apiGet("/api/admin/catalogue/collections", "/api/v1/admin/catalogue/collections")])
  if (!answer.ok && answer.status !== 400) throw new Error(`product list failed with ${answer.status}`)
  if (!collections.ok) throw new Error(`collections failed with ${collections.status}`)
  const products = answer.ok ? answer.data.data : []
  const nextCursor = answer.ok ? answer.data.page.nextCursor : null
  const canWrite = staff.capabilities.has("catalogue.write")
  const filtered = ["search", "status", "collectionId"].some(n => one(params[n]))
  const keep = (extra: Record<string, string>) => {
    const next = new URLSearchParams()
    for (const name of ["search", "status", "collectionId"]) {
      const value = one(params[name])
      if (value) next.set(name, value)
    }
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    return `${base}/products?${next}`
  }

  return (
    <>
      <PageHeader eyebrow="Catalogue" title="Products">
        <p>Drafts are only visible here. A product reaches the shop when an owner publishes it, after its prices, photos, description and shipping restriction pass the publish checks.</p>
      </PageHeader>

      <div className="mb-8 flex flex-wrap gap-3">
        {canWrite && (
          <Button asChild>
            <Link href={`${base}/products/new`}>
              <Plus strokeWidth={1.5} aria-hidden />
              New product
            </Link>
          </Button>
        )}
        <Button asChild variant="quiet">
          <Link href={`${base}/products/collections`}>Collections</Link>
        </Button>
        {canWrite && (
          <Button asChild variant="quiet">
            <Link href={`${base}/products/import`}>Import CSV</Link>
          </Button>
        )}
        <Button asChild variant="quiet">
          <a href="/api/admin/catalogue/export" download>
            Export CSV
          </a>
        </Button>
      </div>

      <form method="get" action={`${base}/products`} className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-2 text-sm lg:col-span-2">
          <span className="label-caps text-ink">Search</span>
          <input name="search" defaultValue={one(params.search) ?? ""} placeholder="Title, handle or SKU" maxLength={100} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="label-caps text-ink">Status</span>
          <select name="status" defaultValue={one(params.status) ?? ""} className={fieldClass}>
            <option value="">Any</option>
            <option value="draft">Draft</option>
            <option value="active">Live</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="label-caps text-ink">Collection</span>
          <select name="collectionId" defaultValue={one(params.collectionId) ?? ""} className={fieldClass}>
            <option value="">Any</option>
            {collections.data.data.map(c => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-3 sm:col-span-2 lg:col-span-4">
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
          <Button asChild variant="link" size="sm">
            <Link href={`${base}/products`}>Clear</Link>
          </Button>
        </div>
      </form>

      {!answer.ok && <p role="alert" className="mb-6 text-sm text-destructive">{problemOf(answer)}</p>}

      {products.length === 0 ? (
        <EmptyState title={filtered ? "No matching products" : "No products yet"}>
          {filtered ? <p>Try fewer filters.</p> : <p>Create the first product, or import a CSV of products prepared by the owner. The demonstration products shown on the shop today are not in this list and are never published.</p>}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line bg-card">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                <th scope="col" className="px-4 py-3 font-semibold">Product</th>
                <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                <th scope="col" className="px-4 py-3 font-semibold">Variants</th>
                <th scope="col" className="px-4 py-3 font-semibold">Price</th>
                <th scope="col" className="px-4 py-3 font-semibold">Photos to review</th>
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-3">
                    <Link href={`${base}/products/${p.id}`} className="font-serif text-lg text-ink underline-offset-4 hover:text-terra hover:underline">
                      {p.title}
                    </Link>
                    <span className="block font-mono text-xs text-muted-foreground">{p.handle}</span>
                  </td>
                  <td className="px-4 py-3 text-ink">{STATUS_LABEL[p.status] ?? p.status}</td>
                  <td className="px-4 py-3 text-ink">{p.variantCount}</td>
                  <td className="px-4 py-3 text-ink">{p.priceFromPaise ? (p.priceFromPaise === p.priceToPaise ? formatPaise(p.priceFromPaise) : `${formatPaise(p.priceFromPaise)} to ${formatPaise(p.priceToPaise)}`) : "Not set"}</td>
                  <td className="px-4 py-3 text-ink">{p.pendingPhotos || "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div className="mt-6">
          <Button asChild variant="outline" size="sm">
            <Link href={keep({ cursor: nextCursor })}>More products</Link>
          </Button>
        </div>
      )}
    </>
  )
}
