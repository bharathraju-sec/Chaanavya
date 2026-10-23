"use client"

// The product editor (Stage 08): details, variant matrix, photos and publishing on one page. It keeps
// the product's ETag from the last answer and sends it with every change, so a save made after
// someone else's change is refused (412) and the page offers to reload instead of overwriting.
// Live products can only be changed by staff who may publish, with a reason for the audit trail.
import { useState } from "react"
import Link from "next/link"
import { Eye, RefreshCw } from "lucide-react"
import { fieldClass, PageHeader, Section } from "@/components/admin/blocks"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PhotoGallery } from "./photo-gallery"
import { CHECKLIST_LABELS, RESTRICTIONS, send, STATUS_LABEL, type AdminProduct, type Problem, type Result } from "./shared"
import { VariantMatrix } from "./variant-matrix"

type CollectionChoice = { id: string; title: string; handle: string }
export type Can = { write: boolean; publish: boolean }
export type EditorContext = {
  product: AdminProduct
  editable: boolean
  live: boolean
  reason: string
  /** Applies an API answer: the new product on success, a conflict notice on 412. Returns the problem, if any. */
  apply: (result: Result<AdminProduct>) => Problem | null
}

export function ProductEditor({ base, initial, collections, can }: { base: string; initial: AdminProduct; collections: CollectionChoice[]; can: Can }) {
  const [product, setProduct] = useState(initial)
  const [conflict, setConflict] = useState(false)
  const [reason, setReason] = useState("")
  // Bumped on reload so every section starts again from the latest product (saves keep unsaved edits elsewhere).
  const [generation, setGeneration] = useState(0)
  const live = product.status === "active"
  const editable = product.status !== "archived" && can.write && (!live || can.publish)

  function apply(result: Result<AdminProduct>) {
    if (result.ok) {
      setProduct(result.data)
      return null
    }
    if (result.problem.status === 412) setConflict(true)
    return result.problem
  }

  async function reload() {
    const result = await send<AdminProduct>("GET", `/api/admin/catalogue/products/${product.id}`)
    if (result.ok) {
      setProduct(result.data)
      setConflict(false)
      setGeneration(g => g + 1)
    }
  }

  const context: EditorContext = { product, editable, live, reason, apply }

  return (
    <>
      <PageHeader eyebrow={`Product / ${STATUS_LABEL[product.status] ?? product.status}`} title={product.title}>
        <p className="font-mono text-sm">/products/{product.handle}</p>
      </PageHeader>

      <div className="mb-8 flex flex-wrap gap-3">
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/products`}>All products</Link>
        </Button>
        <Button asChild variant="quiet" size="sm">
          <Link href={`${base}/products/${product.id}/preview`}>
            <Eye strokeWidth={1.5} aria-hidden />
            Preview
          </Link>
        </Button>
      </div>

      {conflict && (
        <div role="alert" className="mb-8 flex flex-wrap items-center justify-between gap-4 border border-terra bg-card px-5 py-4">
          <p className="text-sm text-ink">Someone else changed this product after you opened it. Nothing of yours was saved. Reload to see the latest version, then make your change again.</p>
          <Button size="sm" onClick={reload}>
            <RefreshCw strokeWidth={1.5} aria-hidden />
            Reload
          </Button>
        </div>
      )}

      {!can.write && <p className="mb-8 border border-line bg-card px-5 py-4 text-sm text-muted-foreground">Your role can view products but not change them.</p>}
      {live && can.write && !can.publish && <p className="mb-8 border border-line bg-card px-5 py-4 text-sm text-muted-foreground">This product is live. Only an owner can change what shoppers see; ask them, or ask them to unpublish it first.</p>}
      {product.status === "archived" && <p className="mb-8 border border-line bg-card px-5 py-4 text-sm text-muted-foreground">This product is archived. It is kept for order history and hidden everywhere. Restore it to edit it.</p>}

      {live && editable && (
        <div className="mb-10 flex max-w-2xl flex-col gap-2 border border-line bg-card px-5 py-4">
          <Label htmlFor="live-reason">Reason for changing the live product</Label>
          <Textarea id="live-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Kept in the audit trail, for example: corrected the fabric description" className="min-h-20 rounded-none border-line-strong bg-paper" />
          <p className="text-xs text-muted-foreground">Every save on this page uses this reason.</p>
        </div>
      )}

      <DetailsForm key={`details-${generation}`} context={context} collections={collections} />
      <VariantMatrix key={`variants-${generation}`} context={context} />
      <PhotoGallery key={`photos-${generation}`} context={context} canPublish={can.publish} canWrite={can.write} />
      <PublishPanel key={`publish-${generation}`} context={context} can={can} />
    </>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  ) : null
}

function DetailsForm({ context, collections }: { context: EditorContext; collections: CollectionChoice[] }) {
  const { product, editable, reason, apply } = context
  const [title, setTitle] = useState(product.title)
  const [handle, setHandle] = useState(product.handle)
  const [description, setDescription] = useState(product.description)
  const [productType, setProductType] = useState(product.productType)
  const [tags, setTags] = useState(product.tags.join(", "))
  const [restriction, setRestriction] = useState(product.shippingRestriction ?? "")
  const [chosen, setChosen] = useState(product.collections.map(c => c.id))
  const [problem, setProblem] = useState<Problem | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setSaved(false)
    const body = {
      title,
      ...(!product.handleLocked && { handle }),
      description,
      productType,
      tags: tags.split(",").map(t => t.trim()).filter(Boolean),
      shippingRestriction: restriction || null,
      collectionIds: chosen,
      ...(reason.trim() && { reason: reason.trim() }),
    }
    const failure = apply(await send<AdminProduct>("PATCH", `/api/admin/catalogue/products/${product.id}`, { body, etag: product.etag }))
    setProblem(failure)
    setSaved(!failure)
    setBusy(false)
  }

  const f = problem?.fields ?? {}
  return (
    <Section title="Details">
      <form onSubmit={save} className="flex max-w-3xl flex-col gap-6" noValidate>
        <fieldset disabled={!editable || busy} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-title">Name</Label>
            <input id="p-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} aria-invalid={Boolean(f.title)} aria-describedby="p-title-error" className={fieldClass} />
            <FieldError id="p-title-error" message={f.title} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-handle">Web address</Label>
            <input id="p-handle" value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} disabled={product.handleLocked} maxLength={100} aria-invalid={Boolean(f.handle)} aria-describedby="p-handle-help" className={`${fieldClass} font-mono`} />
            <p id="p-handle-help" className="text-sm text-muted-foreground">{f.handle ? <span className="text-destructive">{f.handle}</span> : product.handleLocked ? "Fixed: this product has been live, so its address may be bookmarked." : "Can change until the product is first published."}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-description">Description</Label>
            <Textarea id="p-description" value={description} onChange={e => setDescription(e.target.value)} maxLength={10000} aria-invalid={Boolean(f.description)} aria-describedby="p-description-help" className="min-h-40 rounded-none border-line-strong bg-paper text-base" />
            <p id="p-description-help" className="text-sm text-muted-foreground">{f.description ? <span className="text-destructive">{f.description}</span> : "The final, approved text. Material and care claims must be true; the owner confirms them before publishing."}</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-type">Product type</Label>
              <input id="p-type" value={productType} onChange={e => setProductType(e.target.value)} maxLength={80} placeholder="Saree, kurta, eau de parfum" className={fieldClass} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="p-tags">Tags</Label>
              <input id="p-tags" value={tags} onChange={e => setTags(e.target.value)} placeholder="silk, festive" aria-describedby="p-tags-help" className={fieldClass} />
              <p id="p-tags-help" className="text-xs text-muted-foreground">Separate with commas.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-restriction">Shipping restriction</Label>
            <select id="p-restriction" value={restriction} onChange={e => setRestriction(e.target.value)} aria-invalid={Boolean(f.shippingRestriction)} aria-describedby="p-restriction-help" className={fieldClass}>
              <option value="">Not reviewed yet</option>
              {RESTRICTIONS.map(r => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p id="p-restriction-help" className="text-sm text-muted-foreground">Fragrance must be marked as a liquid and jewellery as high value; couriers handle them differently.</p>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-2 text-sm font-medium text-ink">Collections</legend>
            {collections.map(c => (
              <label key={c.id} className="flex min-h-11 items-center gap-3 text-ink">
                <input type="checkbox" className="size-5 accent-[var(--color-terra)]" checked={chosen.includes(c.id)} onChange={e => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter(id => id !== c.id))} />
                {c.title}
              </label>
            ))}
          </fieldset>
        </fieldset>
        {problem && !Object.keys(f).length && <p role="alert" className="text-sm text-destructive">{problem.message}</p>}
        {problem && Object.keys(f).length > 0 && <p role="alert" className="text-sm text-destructive">Check the highlighted fields.</p>}
        {saved && <p role="status" className="text-sm text-ink">Saved.</p>}
        {editable && (
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving" : "Save details"}
            </Button>
          </div>
        )}
      </form>
    </Section>
  )
}

function PublishPanel({ context, can }: { context: EditorContext; can: Can }) {
  const { product, apply } = context
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState("")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  async function act(action: "publish" | "unpublish" | "archive" | "restore") {
    setBusy(true)
    const body = { reason: reason.trim(), ...(action === "publish" && { checklist: confirmed }) }
    const failure = apply(await send<AdminProduct>("POST", `/api/admin/catalogue/products/${product.id}/${action}`, { body, etag: product.etag }))
    setProblem(failure)
    if (!failure) {
      setReason("")
      setConfirmed({})
    }
    setBusy(false)
  }

  const ready = product.blockers.length === 0
  const allConfirmed = product.checklist.every(item => confirmed[item])
  const reasonOk = reason.trim().length >= 3

  return (
    <Section title="Publishing">
      <div className="flex max-w-3xl flex-col gap-6">
        {product.status !== "archived" && (
          <div className="border border-line bg-card px-5 py-4">
            <h3 className="mb-3 font-serif text-xl text-ink">{ready ? "Ready to publish" : "Before this product can go live"}</h3>
            {ready ? (
              <p className="text-sm text-muted-foreground">Every publish check passes.</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
                {product.blockers.map(b => (
                  <li key={`${b.code}:${b.message}`}>{b.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!can.publish ? (
          <p className="text-sm text-muted-foreground">An owner publishes products. When the checks above pass, ask them to review this page.</p>
        ) : (
          <>
            {product.status === "draft" && ready && (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-2 text-sm font-medium text-ink">I confirm that</legend>
                {product.checklist.map(item => (
                  <label key={item} className="flex min-h-11 items-start gap-3 py-1 text-sm text-ink">
                    <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-terra)]" checked={Boolean(confirmed[item])} onChange={e => setConfirmed({ ...confirmed, [item]: e.target.checked })} />
                    {CHECKLIST_LABELS[item] ?? item}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="status-reason">Reason (kept in the audit trail)</Label>
              <Textarea id="status-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} className="min-h-20 rounded-none border-line-strong bg-paper" />
            </div>
            {problem && (
              <div role="alert" className="text-sm text-destructive">
                <p>{problem.message}</p>
                {Object.values(problem.fields).length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {Object.values(problem.fields).map(m => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              {product.status === "draft" && (
                <Button onClick={() => act("publish")} disabled={busy || !ready || !allConfirmed || !reasonOk}>
                  Publish
                </Button>
              )}
              {product.status === "active" && (
                <Button variant="outline" onClick={() => act("unpublish")} disabled={busy || !reasonOk}>
                  Unpublish
                </Button>
              )}
              {product.status !== "archived" && (
                <Button variant="quiet" onClick={() => act("archive")} disabled={busy || !reasonOk}>
                  Archive
                </Button>
              )}
              {product.status === "archived" && (
                <Button variant="outline" onClick={() => act("restore")} disabled={busy || !reasonOk}>
                  Restore as draft
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  )
}
