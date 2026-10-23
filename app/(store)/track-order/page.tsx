import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SUPPORT_WHATSAPP_URL, SupportEmail, SupportPage, SupportPhone } from "@/components/site/support"

export const metadata: Metadata = { alternates: { canonical: "/track-order" }, title: "Track your order", description: "See your Chaanavya order status and tracking, or get help with a delivery." }

// Orders are listed in the customer's Chaanavya account (email-code sign-in).
// Wording follows the Shipping Policy (sections 8 and 15).
export default function TrackOrderPage() {
  return (
    <SupportPage eyebrow="Order support" title="Track order." lead="Once your order is dispatched, tracking details may be shared by email, SMS or WhatsApp. You can also check your order status any time in your Chaanavya account.">
      <div className="mt-11 grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col items-start border border-line bg-card p-7">
          <h2 className="mb-2.5 text-[28px]">Your orders</h2>
          <p className="mb-6 text-[15px] leading-relaxed text-muted-foreground">Sign in with the email address you used for your order; we send you a code, no password needed.</p>
          <Button asChild className="mt-auto w-full">
            <Link href="/account">
              View my orders
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
        <div className="flex flex-col items-start border border-line bg-card p-7">
          <h2 className="mb-2.5 text-[28px]">Need help?</h2>
          <p className="mb-6 text-[15px] leading-relaxed text-muted-foreground">
            If your shipment has not moved for an unusually long time, contact us with your order number.
            <br />
            <SupportEmail />
            <br />
            <SupportPhone />
          </p>
          <Button asChild variant="outline" className="mt-auto w-full">
            <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
              <MessageCircle aria-hidden />
              WhatsApp us
            </a>
          </Button>
        </div>
      </div>
      <p className="mt-8 text-[15px] leading-relaxed text-muted-foreground">
        Tracking may take several hours after dispatch to become active on the courier&apos;s system. For delivery times, charges and delivery issues, see our{" "}
        <Link href="/shipping-policy" className="underline underline-offset-3 hover:text-terra">
          Shipping Policy
        </Link>
        .
      </p>
    </SupportPage>
  )
}
