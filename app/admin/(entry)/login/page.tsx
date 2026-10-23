import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { LoginForm } from "@/components/admin/login-form"
import { adminEntryContext } from "@/lib/auth/permissions"

export const metadata: Metadata = { title: "Sign in" }

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { base, signedIn } = await adminEntryContext()
  if (signedIn && signedIn.roles.length > 0 && (signedIn.passedTwoFactor || signedIn.twoFactorWaived)) redirect(base || "/")
  const { verify } = await searchParams
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <LoginForm base={base} verify={verify === "1"} />
    </div>
  )
}
