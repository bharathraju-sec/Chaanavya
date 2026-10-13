"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

type Field =
  | { name: string; label: string; type?: "text" | "email"; autoComplete?: string; placeholder?: string }
  | { name: string; label: string; type: "textarea" }
  | { name: string; label: string; type: "select"; options: string[]; placeholder: string }

const control = "mt-2 h-12 rounded-none border-line-strong bg-paper px-3.5 text-base shadow-none focus-visible:border-ink focus-visible:ring-0"

// These forms only validate for now; no backend is connected (same as the original site).
export function DemoForm({ fields, submitLabel, successMessage }: { fields: Field[]; submitLabel: string; successMessage: string }) {
  const [status, setStatus] = React.useState("")
  return (
    <form
      className="mt-10 grid gap-5 border border-line bg-card p-[clamp(24px,4vw,40px)]"
      onSubmit={e => {
        e.preventDefault()
        setStatus(successMessage)
      }}
    >
      {fields.map(field => (
        <div key={field.name}>
          <Label htmlFor={field.name} className="label-caps text-[11px]">
            {field.label}
          </Label>
          {field.type === "textarea" ? (
            <Textarea id={field.name} name={field.name} required rows={5} className={`${control} h-auto py-3`} />
          ) : field.type === "select" ? (
            <select id={field.name} name={field.name} required defaultValue="" className={`${control} block w-full border outline-none`}>
              <option value="">{field.placeholder}</option>
              {field.options.map(o => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <Input id={field.name} name={field.name} type={field.type ?? "text"} required autoComplete={field.autoComplete} placeholder={field.placeholder} className={control} />
          )}
        </div>
      ))}
      <Button type="submit" className="h-13">
        {submitLabel}
      </Button>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {status}
      </p>
    </form>
  )
}
