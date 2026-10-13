import type { Metadata } from "next"
import Link from "next/link"
import { ContactBlock, FillIn, PolicySection, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Terms & conditions", description: "Terms of use for shopping at Chaanavya." }

export default function TermsPage() {
  return (
    <SupportPage policy eyebrow="The fine print" title="Terms & conditions." lead={<>Last updated: <FillIn>[date]</FillIn></>}>
      <PolicySection title="About these terms">
        <p>
          By using this website or placing an order with Chaanavya you agree to these terms. Please read them together with our <Link href="/privacy-policy">Privacy policy</Link>, <Link href="/shipping-policy">Shipping policy</Link> and{" "}
          <Link href="/refund-policy">Returns &amp; refunds policy</Link>.
        </p>
      </PolicySection>
      <PolicySection title="Products and pricing">
        <p>All prices are in Indian Rupees (₹) and include applicable taxes unless stated otherwise. We try to show colours and details accurately, but slight variations may occur because products are handmade or due to screen settings. We may correct pricing errors and may cancel orders placed at an incorrect price, with a full refund.</p>
      </PolicySection>
      <PolicySection title="Orders">
        <p>An order is confirmed when payment is successful and you receive an order confirmation. We may cancel an order if a product is unavailable or if we suspect fraud; any amount paid will be refunded in full.</p>
      </PolicySection>
      <PolicySection title="Payments">
        <p>Payments are processed securely by Shopify and Razorpay. We do not store your card or bank details.</p>
      </PolicySection>
      <PolicySection title="Intellectual property">
        <p>All content on this site, including the Chaanavya name, logo, images and text, belongs to Chaanavya and may not be used without written permission.</p>
      </PolicySection>
      <PolicySection title="Liability">
        <p>To the extent permitted by law, Chaanavya is not liable for indirect or consequential losses arising from use of this website or our products. Nothing in these terms limits your rights as a consumer under Indian law.</p>
      </PolicySection>
      <PolicySection title="Governing law">
        <p>
          These terms are governed by the laws of India. Disputes are subject to the courts of <FillIn>[City, State]</FillIn>.
        </p>
      </PolicySection>
      <ContactBlock />
    </SupportPage>
  )
}
