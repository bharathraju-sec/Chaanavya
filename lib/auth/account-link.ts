// Where the header's account button points: our email-code sign-in (which also creates new
// accounts), or the account page once signed in. The API decides who is signed in.
import { currentSession } from "@/lib/api/server"

export type AccountLink = { href: string; label: "Sign in" | "Account"; external: boolean }

export async function accountLink(): Promise<AccountLink> {
  // If the API cannot be reached the visitor is simply shown as signed out; the shop still renders.
  const session = await currentSession().catch(() => null)
  return session?.signedIn ? { href: "/account", label: "Account", external: false } : { href: "/account/sign-in", label: "Sign in", external: false }
}
