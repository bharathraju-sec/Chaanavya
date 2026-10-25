import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Stagger, StaggerItem } from "@/components/motion/motion"
import { SUPPORT_WHATSAPP_URL, SupportCard, SupportEmail, SupportPage, SupportPhone } from "@/components/site/support"

export const metadata: Metadata = { alternates: { canonical: "/track-order" }, title: "Track your order", description: "See your Chaanavya order status and tracking, or get help with a delivery." }

// Orders are listed in the customer's Chaanavya account (email-code sign-in).
// Wording follows the Shipping Policy (sections 8 and 15).
export default function TrackOrderPage() {
  return (
    <SupportPage eyebrow="Order support" title="Track order." lead="Once your order is dispatched, tracking details may be shared by email, SMS or WhatsApp. You can also check your order status any time in your Chaanavya account.">
      <Stagger immediate className="mt-11 grid gap-4 sm:grid-cols-2">
        <StaggerItem>
          <SupportCard
            title="Your orders"
            action={
              <Button asChild className="w-full">
                <Link href="/account">
                  View my orders
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            }
          >
            Sign in with the email address you used for your order; we send you a code, no password needed.
          </SupportCard>
        </StaggerItem>
        <StaggerItem>
          <SupportCard
            title="Need help?"
            action={
              <Button asChild variant="outline" className="w-full">
                <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden />
                  WhatsApp us
                </a>
              </Button>
            }
          >
            If your shipment has not moved for an unusually long time, contact us with your order number.
            <br />
            <SupportEmail />
            <br />
            <SupportPhone />
          </SupportCard>
        </StaggerItem>
      </Stagger>
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
