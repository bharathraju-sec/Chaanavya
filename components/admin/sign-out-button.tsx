"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"

export function SignOutButton({ loginHref }: { loginHref: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function signOut() {
    setBusy(true)
    try {
      await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    } finally {
      router.replace(loginHref)
      router.refresh()
    }
  }
  return (
    <Button variant="quiet" size="sm" onClick={signOut} disabled={busy} className="w-full">
      <LogOut strokeWidth={1.5} aria-hidden />
      {busy ? "Signing out" : "Sign out"}
    </Button>
  )
}
