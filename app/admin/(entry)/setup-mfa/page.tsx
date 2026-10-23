import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { MfaSetup } from "@/components/admin/mfa-setup"
import { adminEntryContext } from "@/lib/auth/permissions"

export const metadata: Metadata = { title: "Set up two-factor sign-in" }

// Staff who signed in with their password but have no authenticator yet. Customers never see this.
export default async function SetupMfaPage() {
  const { base, signedIn } = await adminEntryContext()
  if (!signedIn) redirect(`${base}/login`)
  if (signedIn.roles.length === 0) notFound()
  if (signedIn.twoFactorWaived) redirect(base || "/")
  if (signedIn.twoFactorEnabled) redirect(signedIn.passedTwoFactor ? base || "/" : `${base}/login?verify=1`)
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <MfaSetup base={base} />
    </div>
  )
}
