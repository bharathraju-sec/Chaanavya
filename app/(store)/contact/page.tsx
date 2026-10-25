import type { Metadata } from "next"
import Link from "next/link"
import { Mail, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Stagger, StaggerItem } from "@/components/motion/motion"
import { SUPPORT_EMAIL, SUPPORT_WHATSAPP_URL, SupportCard, SupportEmail, SupportPage, SupportPhone } from "@/components/site/support"

export const metadata: Metadata = { alternates: { canonical: "/contact" }, title: "Contact us", description: "Contact Chaanavya by email or WhatsApp about sizing, fabric, orders and returns." }

// Contact details are the owner-confirmed ones from the policies (13 October 2026). There is no
// contact form backend, so the page links straight to email and WhatsApp instead of a preview form.
export default function ContactPage() {
  return (
    <SupportPage eyebrow="We are here to help" title="Contact." lead="Questions about sizing, fabric, an order or a return? Contact us by email or WhatsApp.">
      <Stagger immediate className="mt-11 grid gap-4 sm:grid-cols-2">
        <StaggerItem>
          <SupportCard
            title="Email"
            action={
              <Button asChild variant="outline" className="w-full">
                <a href={`mailto:${SUPPORT_EMAIL}`}>
                  <Mail aria-hidden />
                  Email us
                </a>
              </Button>
            }
          >
            <SupportEmail />
          </SupportCard>
        </StaggerItem>
        <StaggerItem>
          <SupportCard
            title="Phone / WhatsApp"
            action={
              <Button asChild variant="outline" className="w-full">
                <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden />
                  WhatsApp us
                </a>
              </Button>
            }
          >
            <SupportPhone />
          </SupportCard>
        </StaggerItem>
      </Stagger>
      <p className="mt-8 text-[15px] leading-relaxed text-muted-foreground">
        For an existing order, please include your order number. You can also see your order status on the{" "}
        <Link href="/track-order" className="underline underline-offset-3 hover:text-terra">
          Track order
        </Link>{" "}
        page. Chaanavya is based in Bengaluru, Karnataka, India.
      </p>
    </SupportPage>
  )
}
