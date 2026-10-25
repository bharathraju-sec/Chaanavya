import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { toDisplayMoney } from "@chaanavya/shared/money-display"
import { CustomerSignOutButton } from "@/components/account/sign-in-form"
import { apiGet, currentSession } from "@/lib/api/server"
import { formatMoney } from "@/lib/types"
import { Enter, MaskLines, Stagger, StaggerItem } from "@/components/motion/motion"

export const metadata: Metadata = { title: "Your account", robots: { index: false } }

const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })
const STATUS: Record<string, string> = { pending_payment: "Awaiting payment", needs_review: "Being checked", confirmed: "Confirmed", completed: "Delivered", cancelled: "Cancelled" }

// The signed-in customer's own orders, from the API (which only ever returns this account's orders).
// Order details and addresses arrive with the account pages.
export default async function AccountPage() {
  const session = await currentSession()
  if (!session.signedIn || !session.user) redirect("/account/sign-in")
  const result = await apiGet("/api/account/orders", "/api/v1/account/orders")
  if (!result.ok) {
    if (result.status === 401) redirect("/account/sign-in")
    throw new Error(`orders lookup failed with ${result.status}`)
  }
  const orders = result.data.orders

  return (
    <div className="page-wrap section-y">
      <Enter>
        <p className="eyebrow flex items-center gap-3">
          <span className="h-px w-10 bg-gold" aria-hidden />
          Your account
        </p>
      </Enter>
      <MaskLines lines={["Your orders"]} className="mt-3 mb-3 text-[clamp(44px,6vw,72px)]" />
      <Enter delay={0.3}>
        <p className="mb-10 break-all text-muted-foreground">Signed in as {session.user.email}</p>
      </Enter>

      {orders.length === 0 ? (
        <Enter delay={0.4} className="max-w-xl border border-line bg-card px-6 py-8">
          <p className="font-serif text-2xl">No orders yet</p>
          <p className="mt-2 text-sm text-muted-foreground">Orders you place while signed in will be listed here.</p>
        </Enter>
      ) : (
        <Stagger immediate className="max-w-3xl divide-y divide-line border-y border-line">
          {orders.map(o => (
            <StaggerItem key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4">
              <span className="font-serif text-xl">{o.number}</span>
              <span className="text-sm text-muted-foreground">{date.format(new Date(o.createdAt))}</span>
              <span className="text-sm">{STATUS[o.status] ?? o.status}</span>
              <span className="text-sm">{formatMoney(toDisplayMoney(o.grandTotal.amountPaise, o.grandTotal.currency))}</span>
            </StaggerItem>
          ))}
        </Stagger>
      )}

      <p className="mt-8 max-w-xl text-sm text-muted-foreground">
        Questions about an order? <Link href="/contact" className="underline underline-offset-4 hover:text-terra">Contact us</Link>.
      </p>
      <div className="mt-10">
        <CustomerSignOutButton />
      </div>
    </div>
  )
}
