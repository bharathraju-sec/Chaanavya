"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

const field = "h-12 w-full border border-line-strong bg-paper px-3.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-ink"
const post = (path: string, body: object) => fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

// Customer sign-in and sign-up in one: a 6-digit code goes to the email address; the first
// successful code creates the account. No passwords.
export function CustomerSignInForm() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post("/email-otp/send-verification-otp", { email: email.trim(), type: "sign-in" })
      if (res.status === 429) return setError("Too many codes requested. Wait a minute, then try again.")
      if (!res.ok) return setError(res.status === 400 ? "Enter a valid email address." : "We could not send a code right now. Please try again later.")
      setSent(true)
      setCode("")
    } finally {
      setBusy(false)
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post("/sign-in/email-otp", { email: email.trim(), otp: code.trim() })
      if (res.status === 429) return setError("Too many attempts. Wait a minute, then try again.")
      if (!res.ok) return setError("That code is not right or has expired. Codes last 5 minutes; you can ask for a new one.")
      router.replace("/account")
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-md border border-line bg-card px-6 py-10 sm:px-10">
      <p className="eyebrow">Your account</p>
      <h1 className="mt-3 mb-3 text-[clamp(36px,5vw,48px)]">{sent ? "Check your email" : "Sign in or sign up"}</h1>
      <p className="text-sm text-muted-foreground">
        {sent ? `We sent a 6-digit code to ${email.trim()}. It works for 5 minutes.` : "Enter your email and we will send you a code. New here? The same code creates your account. No password needed."}
      </p>

      {!sent ? (
        <form onSubmit={sendCode} className="mt-8 flex flex-col gap-5" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-email">Email</Label>
            <input id="account-email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} className={field} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? "Sending" : "Send code"}
            <ArrowRight strokeWidth={1.5} aria-hidden />
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-8 flex flex-col gap-5" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-code">6-digit code</Label>
            <input id="account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={e => setCode(e.target.value)} className={`${field} tracking-[0.3em]`} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || code.trim().length !== 6}>
            {busy ? "Checking" : "Continue"}
            <ArrowRight strokeWidth={1.5} aria-hidden />
          </Button>
          <div className="flex flex-wrap gap-x-6">
            <Button type="button" variant="link" onClick={() => sendCode()} disabled={busy}>
              Send a new code
            </Button>
            <Button type="button" variant="link" onClick={() => (setSent(false), setError(null))} disabled={busy}>
              Use another email
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

export function CustomerSignOutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await post("/sign-out", {})
        } finally {
          router.replace("/")
          router.refresh()
        }
      }}
    >
      {busy ? "Signing out" : "Sign out"}
    </Button>
  )
}
