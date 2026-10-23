import Link from "next/link"
import { notFound } from "next/navigation"
import { AccessDenied } from "@/components/admin/blocks"
import { formatPaise, STATUS_LABEL } from "@/components/admin/catalogue/shared"
import { Button } from "@/components/ui/button"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Draft preview (Stage 08): roughly how the product page will read, from the admin data, including
// photos still waiting for review. Staff only (admin host, noindex); shoppers never see drafts.
export default async function ProductPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { allowed, base } = await requireAdminPage("catalogue.read")
  if (!allowed) return <AccessDenied section="Products" />
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const answer = await apiGet(`/api/admin/catalogue/products/${id}`, "/api/v1/admin/catalogue/products/{id}")
  if (!answer.ok && answer.status === 404) notFound()
  if (!answer.ok) throw new Error(`product failed with ${answer.status}`)
  const p = answer.data.data
  const photos = p.media.filter(m => m.status !== "rejected" && m.previewUrl)
  const prices = p.variants.map(v => BigInt(v.pricePaise))
  const min = prices.length ? prices.reduce((a, b) => (b < a ? b : a)).toString() : null
  const max = prices.length ? prices.reduce((a, b) => (b > a ? b : a)).toString() : null

  return (
    <>
      <div role="note" className="mb-10 flex flex-wrap items-center justify-between gap-4 border border-terra bg-card px-5 py-4">
        <p className="text-sm text-ink">
          {`Preview of a ${STATUS_LABEL[p.status]?.toLowerCase() ?? p.status} product. ${p.status === "active" ? "Shoppers see the approved photos only." : "Shoppers cannot see this page."} Photos marked as waiting are not public yet.`}
        </p>
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/products/${p.id}`}>Back to editing</Link>
        </Button>
      </div>

      <article className="grid gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="grid gap-4 sm:grid-cols-2">
          {photos.length === 0 && <div className="aspect-[4/5] bg-well sm:col-span-2" aria-label="No photos yet" />}
          {photos.map((m, i) => (
            <figure key={m.id} className={`relative aspect-[4/5] bg-well ${i === 0 ? "sm:col-span-2" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.previewUrl!} alt={m.altText ?? ""} width={m.width ?? undefined} height={m.height ?? undefined} className="absolute inset-0 size-full object-cover" />
              {m.status === "pending" && <figcaption className="absolute top-3 left-3 bg-paper px-2 py-1 text-[11px] font-semibold tracking-[0.12em] text-ink uppercase">Waiting for review</figcaption>}
            </figure>
          ))}
        </div>
        <div>
          <p className="eyebrow mb-3">{p.collections.map(c => c.title).join(" / ") || "No collection"}</p>
          <h1 className="text-[clamp(36px,4vw,52px)] text-ink">{p.title}</h1>
          <p className="mt-4 text-xl text-ink">{min ? (min === max ? formatPaise(min) : `${formatPaise(min)} to ${formatPaise(max)}`) : "No price yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">Inclusive of GST</p>
          {p.options.map(o => (
            <div key={o.name} className="mt-8">
              <p className="label-caps mb-3 text-ink">{o.name}</p>
              <ul className="flex flex-wrap gap-2">
                {o.values.map(v => (
                  <li key={v} className="flex h-11 min-w-11 items-center justify-center border border-line-strong px-4 text-sm text-ink">
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="mt-10 max-w-prose text-base leading-relaxed whitespace-pre-line text-ink">{p.description || <span className="text-muted-foreground">No description yet.</span>}</div>
        </div>
      </article>
    </>
  )
}
