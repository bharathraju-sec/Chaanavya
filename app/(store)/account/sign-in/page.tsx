import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { CustomerSignInForm } from "@/components/account/sign-in-form"
import { currentSession } from "@/lib/api/server"

export const metadata: Metadata = { title: "Sign in", robots: { index: false } }

// Customer sign-in and sign-up with an emailed code.
export default async function SignInPage() {
  if ((await currentSession()).signedIn) redirect("/account")
  return (
    <div className="page-wrap section-y flex justify-center">
      <CustomerSignInForm />
    </div>
  )
}
