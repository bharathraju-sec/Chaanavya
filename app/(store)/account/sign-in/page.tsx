import type { Metadata } from "next"
import { redirect } from "next/navigation"
import Image from "next/image"
import { CustomerSignInForm } from "@/components/account/sign-in-form"
import { Enter } from "@/components/motion/motion"
import { currentSession } from "@/lib/api/server"

export const metadata: Metadata = { title: "Sign in", robots: { index: false } }

// Customer sign-in and sign-up with an emailed code.
export default async function SignInPage() {
  if ((await currentSession()).signedIn) redirect("/account")
  return (
    // Wide screens: an editorial photo beside the form; phones: the form alone.
    <div className="page-wrap grid items-center gap-[clamp(32px,5vw,80px)] py-[clamp(40px,6vw,96px)] lg:grid-cols-2">
      <Enter className="relative hidden aspect-[4/5] max-h-[72svh] overflow-hidden bg-well lg:block">
        <Image src="https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=900&q=75&auto=format&fit=crop" alt="" fill sizes="50vw" className="object-cover" />
      </Enter>
      <Enter delay={0.15} className="flex justify-center">
        <CustomerSignInForm />
      </Enter>
    </div>
  )
}
