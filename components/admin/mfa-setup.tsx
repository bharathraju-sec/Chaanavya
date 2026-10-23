"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { fieldClass } from "@/components/admin/blocks"

const post = (path: string, body: object) => fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

// Two-factor enrolment for staff: confirm the password, add the key to an authenticator app, save
// the backup codes, then prove it works with a code. Admin access starts only after that.
export function MfaSetup({ base }: { base: string }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [setup, setSetup] = useState<{ secret: string; uri: string; backupCodes: string[] } | null>(null)
  const [code, setCode] = useState("")
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post("/two-factor/enable", { password })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.totpURI) return setError(res.status === 429 ? "Too many attempts. Wait a minute." : "That password is not correct.")
      const secret = new URL(body.totpURI).searchParams.get("secret") ?? ""
      setSetup({ secret, uri: body.totpURI, backupCodes: body.backupCodes ?? [] })
      setPassword("")
    } finally {
      setBusy(false)
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post("/two-factor/verify-totp", { code: code.trim() })
      if (!res.ok) return setError("That code did not work. Check the time on your phone and try the newest code.")
      router.replace(base || "/")
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-xl border border-line bg-card px-6 py-10 sm:px-10">
      <p className="eyebrow">Two-factor sign-in</p>
      <h1 className="mt-3 mb-3 text-[40px] text-ink">Set up your authenticator</h1>
      <p className="text-sm text-muted-foreground">Admin work needs a second step at every sign-in: a 6-digit code from an authenticator app on your phone.</p>

      {!setup ? (
        <form onSubmit={start} className="mt-8 flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Confirm your password</Label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className={fieldClass} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !password}>
            {busy ? "Preparing" : "Continue"}
            <ArrowRight strokeWidth={1.5} aria-hidden />
          </Button>
        </form>
      ) : (
        <form onSubmit={confirm} className="mt-8 flex flex-col gap-8">
          <ol className="flex flex-col gap-6 text-sm">
            <li>
              <p className="label-caps mb-2 text-ink">1. Add this key to your authenticator app</p>
              <p className="mb-2 text-muted-foreground">Choose &ldquo;enter a setup key&rdquo; in the app, name it Chaanavya, and type the key below. On a phone you can tap the link instead.</p>
              <p className="border border-line bg-paper px-4 py-3 font-mono text-base break-all text-ink" aria-label="Setup key">
                {setup.secret.match(/.{1,4}/g)?.join(" ")}
              </p>
              <a href={setup.uri} className="mt-2 inline-block text-sm underline underline-offset-4 hover:text-terra">
                Open in authenticator app
              </a>
            </li>
            <li>
              <p className="label-caps mb-2 text-ink">2. Save your backup codes</p>
              <p className="mb-2 text-muted-foreground">Each code signs you in once if you lose your phone. Keep them somewhere safe and private. They are shown only now.</p>
              <ul className="grid grid-cols-2 gap-2 border border-line bg-paper px-4 py-3 font-mono text-sm text-ink">
                {setup.backupCodes.map(c => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <label className="mt-3 flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} className="size-4 accent-[var(--color-ink)]" />
                I have saved my backup codes
              </label>
            </li>
            <li>
              <Label htmlFor="code" className="label-caps mb-2 block text-ink">
                3. Enter the code the app shows
              </Label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={e => setCode(e.target.value)} className={`${fieldClass} tracking-[0.3em]`} />
            </li>
          </ol>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !saved || code.trim().length < 6}>
            {busy ? "Checking" : "Turn on two-factor"}
            <ArrowRight strokeWidth={1.5} aria-hidden />
          </Button>
        </form>
      )}
    </div>
  )
}
