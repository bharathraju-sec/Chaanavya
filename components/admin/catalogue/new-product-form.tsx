"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { fieldClass } from "@/components/admin/blocks"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { send, type AdminProduct } from "./shared"

type CollectionChoice = { id: string; title: string; handle: string }

export function NewProductForm({ base, collections }: { base: string; collections: CollectionChoice[] }) {
  const router = useRouter()
  const [title, setTitle] = useState("")
  const [handle, setHandle] = useState("")
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null)

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await send<AdminProduct>("POST", "/api/admin/catalogue/products", { body: { title, ...(handle.trim() && { handle: handle.trim() }), collectionIds: chosen } })
    if (result.ok) {
      router.push(`${base}/products/${result.data.id}`)
      return
    }
    setError(result.problem)
    setBusy(false)
  }

  return (
    <form onSubmit={create} className="flex max-w-2xl flex-col gap-6" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-title">Product name</Label>
        <input id="new-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required aria-invalid={Boolean(error?.fields.title)} aria-describedby="new-title-error" className={fieldClass} />
        {error?.fields.title && <p id="new-title-error" className="text-sm text-destructive">{error.fields.title}</p>}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-handle">Web address (optional)</Label>
        <input id="new-handle" value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} maxLength={100} placeholder="made from the name if left empty" aria-invalid={Boolean(error?.fields.handle)} aria-describedby="new-handle-help" className={`${fieldClass} font-mono`} />
        <p id="new-handle-help" className="text-sm text-muted-foreground">
          {error?.fields.handle ? <span className="text-destructive">{error.message}</span> : "The page will be chaanavya.in/products/<address>. It can change until the product is first published."}
        </p>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-ink">Collections</legend>
        {collections.map(c => (
          <label key={c.id} className="flex min-h-11 items-center gap-3 text-ink">
            <input type="checkbox" className="size-5 accent-[var(--color-terra)]" checked={chosen.includes(c.id)} onChange={e => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter(id => id !== c.id))} />
            {c.title}
            <span className="font-mono text-xs text-muted-foreground">/{c.handle}</span>
          </label>
        ))}
      </fieldset>
      {error && !error.fields.title && !error.fields.handle && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? "Creating" : "Create draft"}
        </Button>
      </div>
    </form>
  )
}
