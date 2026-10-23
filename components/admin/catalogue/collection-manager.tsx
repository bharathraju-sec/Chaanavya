"use client"

import { useState } from "react"
import { fieldClass, Section } from "@/components/admin/blocks"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { send, type AdminCollection, type Problem } from "./shared"

type Can = { write: boolean; publish: boolean }

export function CollectionManager({ initial, can }: { initial: AdminCollection[]; can: Can }) {
  const [collections, setCollections] = useState(initial)
  const replace = (c: AdminCollection) => setCollections(list => (list.some(x => x.id === c.id) ? list.map(x => (x.id === c.id ? c : x)) : [...list, c]))
  return (
    <>
      <Section title="All collections">
        <ul className="flex flex-col gap-6">
          {collections.map(c => (
            <CollectionRow key={c.id} collection={c} can={can} onSaved={replace} />
          ))}
        </ul>
      </Section>
      {can.write && <NewCollection onCreated={replace} />}
    </>
  )
}

function CollectionRow({ collection, can, onSaved }: { collection: AdminCollection; can: Can; onSaved: (c: AdminCollection) => void }) {
  const [title, setTitle] = useState(collection.title)
  const [description, setDescription] = useState(collection.description)
  const [reason, setReason] = useState("")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(patch: Record<string, unknown>) {
    setBusy(true)
    const result = await send<AdminCollection>("PATCH", `/api/admin/catalogue/collections/${collection.id}`, { body: { ...patch, ...(reason.trim() && { reason: reason.trim() }) }, etag: collection.etag })
    if (result.ok) {
      onSaved(result.data)
      setProblem(null)
      setReason("")
    } else setProblem(result.problem)
    setBusy(false)
  }

  const changed = title !== collection.title || description !== collection.description
  return (
    <li className="border border-line bg-card p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-sm text-ink">/{collection.handle}</p>
        <p className="text-sm text-muted-foreground">
          {collection.storefront ? "Shop category" : "Collection"} / {collection.hidden ? "Hidden from shoppers" : "Visible"} / {collection.productCount} {collection.productCount === 1 ? "product" : "products"}
        </p>
      </div>
      <fieldset disabled={!can.write || busy} className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`c-title-${collection.id}`}>Name</Label>
          <input id={`c-title-${collection.id}`} value={title} onChange={e => setTitle(e.target.value)} maxLength={120} className={fieldClass} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`c-desc-${collection.id}`}>Description</Label>
          <Textarea id={`c-desc-${collection.id}`} value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} className="min-h-12 rounded-none border-line-strong bg-paper" />
        </div>
        {can.publish && (
          <div className="flex flex-col gap-2 lg:col-span-2">
            <Label htmlFor={`c-reason-${collection.id}`}>Reason, to show or hide it (kept in the audit trail)</Label>
            <input id={`c-reason-${collection.id}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} className={fieldClass} />
          </div>
        )}
      </fieldset>
      {problem && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem.message}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        {can.write && changed && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save({ title, description })}>
            Save
          </Button>
        )}
        {can.publish && (
          <Button size="sm" variant="quiet" disabled={busy || reason.trim().length < 3} onClick={() => save({ hidden: !collection.hidden })}>
            {collection.hidden ? "Show to shoppers" : "Hide from shoppers"}
          </Button>
        )}
      </div>
    </li>
  )
}

function NewCollection({ onCreated }: { onCreated: (c: AdminCollection) => void }) {
  const [handle, setHandle] = useState("")
  const [title, setTitle] = useState("")
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    const result = await send<AdminCollection>("POST", "/api/admin/catalogue/collections", { body: { handle, title } })
    if (result.ok) {
      onCreated(result.data)
      setHandle("")
      setTitle("")
      setProblem(null)
    } else setProblem(result.problem)
    setBusy(false)
  }

  return (
    <Section title="New collection">
      <form onSubmit={create} className="grid max-w-3xl gap-4 sm:grid-cols-2" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="nc-title">Name</Label>
          <input id="nc-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} className={fieldClass} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="nc-handle">Web address</Label>
          <input id="nc-handle" value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} maxLength={100} placeholder="festive-edit" className={`${fieldClass} font-mono`} />
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {Object.values(problem.fields)[0] ?? problem.message}
          </p>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy || !title.trim() || !handle.trim()}>
            Create hidden collection
          </Button>
        </div>
      </form>
    </Section>
  )
}
