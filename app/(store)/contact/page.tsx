import type { Metadata } from "next"
import Link from "next/link"
import { Mail, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SUPPORT_EMAIL, SUPPORT_WHATSAPP_URL, SupportEmail, SupportPage, SupportPhone } from "@/components/site/support"

export const metadata: Metadata = { alternates: { canonical: "/contact" }, title: "Contact us", description: "Contact Chaanavya by email or WhatsApp about sizing, fabric, orders and returns." }

// Contact details are the owner-confirmed ones from the policies (13 October 2026). There is no
// contact form backend, so the page links straight to email and WhatsApp instead of a preview form.
export default function ContactPage() {
  return (
    <SupportPage eyebrow="We are here to help" title="Contact." lead="Questions about sizing, fabric, an order or a return? Contact us by email or WhatsApp.">
      <div className="mt-11 grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col items-start border border-line bg-card p-7">
          <h2 className="mb-2.5 text-[28px]">Email</h2>
          <p className="mb-6 text-[15px] leading-relaxed text-muted-foreground">
            <SupportEmail />
          </p>
          <Button asChild variant="outline" className="mt-auto w-full">
            <a href={`mailto:${SUPPORT_EMAIL}`}>
              <Mail aria-hidden />
              Email us
            </a>
          </Button>
        </div>
        <div className="flex flex-col items-start border border-line bg-card p-7">
          <h2 className="mb-2.5 text-[28px]">Phone / WhatsApp</h2>
          <p className="mb-6 text-[15px] leading-relaxed text-muted-foreground">
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
        For an existing order, please include your order number. You can also see your order status on the{" "}
        <Link href="/track-order" className="underline underline-offset-3 hover:text-terra">
          Track order
        </Link>{" "}
        page. Chaanavya is based in Bengaluru, Karnataka, India.
      </p>
    </SupportPage>
  )
}
