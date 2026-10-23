"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { fieldClass } from "@/components/admin/blocks"

type Step = "credentials" | "code"

const post = (path: string, body: object) => fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

function failureMessage(status: number, fallback: string) {
  if (status === 429) return "Too many attempts. Wait a minute, then try again."
  if (status === 401 || status === 400) return fallback
  return "Sign-in is unavailable right now. Try again shortly."
}

// Staff sign-in: email and password, then the 6-digit code from the authenticator app (or a backup
// code). Staff without an authenticator yet are sent to enrolment.
export function LoginForm({ base, verify }: { base: string; verify: boolean }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>("credentials")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [backup, setBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post("/sign-in/email", { email, password })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return setError(failureMessage(res.status, "That email and password do not match a staff account."))
      if (body.twoFactorRedirect) {
        setStep("code")
        setPassword("")
        return
      }
      router.replace(`${base}/setup-mfa`)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post(backup ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp", { code: code.trim() })
      if (!res.ok) return setError(failureMessage(res.status, backup ? "That backup code did not work." : "That code did not work. Check the time on your phone and try the newest code."))
      router.replace(base || "/")
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-md border border-line bg-card px-6 py-10 sm:px-10">
      <p className="eyebrow">Chaanavya admin</p>
      <h1 className="mt-3 mb-2 text-[40px] text-ink">{step === "credentials" ? "Sign in" : "Enter your code"}</h1>
      {verify && step === "credentials" && <p className="mb-4 text-sm text-muted-foreground">Admin work needs a sign-in with your password and authenticator code.</p>}
      {step === "code" && <p className="mb-4 text-sm text-muted-foreground">{backup ? "Enter one of your saved backup codes. Each works once." : "Open your authenticator app and enter the 6-digit code for Chaanavya."}</p>}

      {step === "credentials" ? (
        <form onSubmit={submitCredentials} className="mt-6 flex flex-col gap-5" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} className={fieldClass} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className={fieldClass} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !email || !password}>
            {busy ? "Signing in" : "Continue"}
            <ArrowRight strokeWidth={1.5} aria-hidden />
          </Button>
        </form>
      ) : (
        <form onSubmit={submitCode} className="mt-6 flex flex-col gap-5" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="code">{backup ? "Backup code" : "Authenticator code"}</Label>
            <input
              id="code"
              inputMode={backup ? "text" : "numeric"}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={e => setCode(e.target.value)}
              className={`${fieldClass} tracking-[0.3em]`}
            />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !code.trim()}>
            {busy ? "Checking" : "Sign in"}
            <ArrowRight strokeWidth={1.5} aria-hidden />
          </Button>
          <Button type="button" variant="link" onClick={() => (setBackup(!backup), setCode(""), setError(null))}>
            {backup ? "Use the authenticator code" : "Use a backup code"}
          </Button>
        </form>
      )}
    </div>
  )
}
