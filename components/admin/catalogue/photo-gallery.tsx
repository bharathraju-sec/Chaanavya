"use client"

// Photo gallery (Stage 08). Uploads go from this browser straight to private storage with a signed
// link that only accepts this exact file (type, size and SHA-256 computed here); the API then checks
// the stored file before it appears as "waiting for review". An owner approves or rejects each photo;
// only approved photos ever reach shoppers. Photos show through short-lived signed links until then.
import { useRef, useState } from "react"
import { ArrowDown, ArrowUp, Upload } from "lucide-react"
import { Section } from "@/components/admin/blocks"
import { Button } from "@/components/ui/button"
import type { EditorContext } from "./product-editor"
import { PHOTO_MAX_BYTES, PHOTO_TYPES, send, sha256Base64, type AdminProduct, type Problem, type UploadIntent } from "./shared"

type Media = AdminProduct["media"][number]

const STATUS: Record<string, string> = { pending: "Waiting for review", approved: "Approved", rejected: "Rejected" }
const cell = "h-11 w-full border border-line-strong bg-paper px-2.5 text-sm outline-none focus:border-ink"

export function PhotoGallery({ context, canPublish, canWrite }: { context: EditorContext; canPublish: boolean; canWrite: boolean }) {
  const { product, live, reason, apply } = context
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const canUpload = canWrite && product.status !== "archived"

  async function upload(files: FileList | null) {
    if (!files?.length) return
    const failed: string[] = []
    for (const file of Array.from(files)) {
      if (!PHOTO_TYPES.includes(file.type)) {
        failed.push(`${file.name}: use JPEG, PNG, WebP or AVIF.`)
        continue
      }
      if (file.size > PHOTO_MAX_BYTES) {
        failed.push(`${file.name}: photos can be up to 10 MB.`)
        continue
      }
      setProgress(`Checking ${file.name}`)
      const checksumSha256 = await sha256Base64(file)
      const intent = await send<UploadIntent>("POST", `/api/admin/catalogue/products/${product.id}/media/uploads`, { body: { contentType: file.type, byteSize: file.size, checksumSha256 } })
      if (!intent.ok) {
        failed.push(`${file.name}: ${intent.problem.message}`)
        continue
      }
      setProgress(`Uploading ${file.name}`)
      const put = await fetch(intent.data.upload.url, { method: "PUT", body: file, headers: intent.data.upload.headers }).catch(() => null)
      if (!put?.ok) {
        failed.push(`${file.name}: the upload did not finish. Try again.`)
        continue
      }
      setProgress(`Verifying ${file.name}`)
      const done = apply(await send<AdminProduct>("POST", `/api/admin/catalogue/media/uploads/${intent.data.uploadId}/complete`, { body: {} }))
      if (done) failed.push(`${file.name}: ${done.message}`)
    }
    setProgress(null)
    setProblems(failed)
    if (input.current) input.current.value = ""
  }

  const visible = [...product.media].sort((a, b) => a.position - b.position)

  return (
    <Section title="Photos">
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">JPEG, PNG, WebP or AVIF, up to 10 MB, at least 400 pixels on the shortest side. New photos stay private until an owner approves them. Every approved photo needs a short description for people who cannot see it.</p>
      {canUpload && (
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <input ref={input} id="photo-input" type="file" accept={PHOTO_TYPES.join(",")} multiple className="sr-only" onChange={e => upload(e.target.files)} />
          <Button asChild variant="outline" size="sm">
            <label htmlFor="photo-input" className="cursor-pointer">
              <Upload strokeWidth={1.5} aria-hidden />
              Add photos
            </label>
          </Button>
          {progress && (
            <p role="status" className="text-sm text-ink">
              {progress}
            </p>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="mb-6 list-disc pl-5 text-sm text-destructive">
          {problems.map(p => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No photos yet.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((m, i) => (
            <PhotoCard key={m.id} media={m} index={i} before={visible[i - 1]?.position} after={visible[i + 1]?.position} count={visible.length} context={context} canPublish={canPublish} canWrite={canWrite} live={live} reason={reason} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function PhotoCard({ media, index, before, after, count, context, canPublish, canWrite, live, reason }: { media: Media; index: number; before?: number; after?: number; count: number; context: EditorContext; canPublish: boolean; canWrite: boolean; live: boolean; reason: string }) {
  const { product, apply } = context
  const [alt, setAlt] = useState(media.altText ?? "")
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const shownToShoppers = live && media.status === "approved"
  const canEdit = canWrite && product.status !== "archived" && (!shownToShoppers || canPublish)
  const withReason = (body: object) => ({ ...body, ...(reason.trim() && { reason: reason.trim() }) })

  async function run(method: string, path: string, body?: object) {
    setBusy(true)
    setProblem(apply(await send<AdminProduct>(method, path, { body, etag: product.etag })))
    setBusy(false)
  }

  return (
    <li className="flex flex-col border border-line bg-card">
      <div className="relative aspect-[4/5] bg-well">
        {media.previewUrl ? (
          // Signed and public storage links are not served through next/image (decision 034).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.previewUrl} alt={media.altText ?? ""} width={media.width ?? undefined} height={media.height ?? undefined} className="absolute inset-0 size-full object-cover" />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">{media.status === "rejected" ? "Rejected photo (file deleted)" : "Preview unavailable"}</p>
        )}
      </div>
      <div className="flex flex-col gap-3 p-4">
        <p className="label-caps text-ink">
          {STATUS[media.status] ?? media.status}
          {media.width && media.height ? <span className="ml-2 font-normal text-muted-foreground normal-case tracking-normal">{media.width} x {media.height}</span> : null}
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink">Description (alt text)</span>
          <input value={alt} onChange={e => setAlt(e.target.value)} maxLength={300} disabled={!canEdit || busy || media.status === "rejected"} placeholder="Model wearing the kurta, front view" className={cell} />
        </label>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && media.status !== "rejected" && alt !== (media.altText ?? "") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("PATCH", `/api/admin/catalogue/media/${media.id}`, withReason({ altText: alt }))}>
              Save description
            </Button>
          )}
          {canPublish && media.status === "pending" && !rejecting && (
            <>
              <Button size="sm" disabled={busy} onClick={() => run("POST", `/api/admin/catalogue/media/${media.id}/approve`, {})}>
                Approve
              </Button>
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </>
          )}
          {canEdit && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label="Move photo earlier" disabled={busy || index === 0} onClick={() => run("PATCH", `/api/admin/catalogue/media/${media.id}`, withReason({ position: before ?? 0 }))}>
                <ArrowUp strokeWidth={1.5} aria-hidden />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Move photo later" disabled={busy || index === count - 1} onClick={() => run("PATCH", `/api/admin/catalogue/media/${media.id}`, withReason({ position: (after ?? media.position) + 1 }))}>
                <ArrowDown strokeWidth={1.5} aria-hidden />
              </Button>
              <Button size="sm" variant="link" disabled={busy} onClick={() => run("DELETE", `/api/admin/catalogue/media/${media.id}`, withReason({}))}>
                Remove
              </Button>
            </>
          )}
        </div>
        {rejecting && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink">Why is it rejected?</span>
              <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} maxLength={500} placeholder="Blurry, wrong colour, not our product" className={cell} />
            </label>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || rejectReason.trim().length < 3} onClick={() => run("POST", `/api/admin/catalogue/media/${media.id}/reject`, { reason: rejectReason.trim() }).then(() => setRejecting(false))}>
                Reject photo
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  )
}
