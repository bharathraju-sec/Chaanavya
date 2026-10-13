import type { Metadata } from "next"
import Link from "next/link"
import { ContactBlock, FillIn, PolicySection, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Shipping policy", description: "Chaanavya shipping charges, delivery times and tracking." }

export default function ShippingPolicyPage() {
  return (
    <SupportPage policy eyebrow="Delivered with care" title="Shipping policy." lead={<>Last updated: <FillIn>[date]</FillIn></>}>
      <PolicySection title="Where we ship">
        <p>
          We currently ship across India. <FillIn>[Add international shipping details if applicable]</FillIn>
        </p>
      </PolicySection>
      <PolicySection title="Charges">
        <p>
          Shipping is <strong>free on orders over ₹2,499</strong>. Orders below this have a flat charge of <FillIn>[₹ amount]</FillIn>.
        </p>
      </PolicySection>
      <PolicySection title="Processing and delivery times">
        <p>
          Orders are processed within <FillIn>[1-2]</FillIn> business days. Delivery usually takes <FillIn>[3-7]</FillIn> business days after dispatch, depending on your location. Made-to-order pieces may take longer; we will tell you before you order.
        </p>
      </PolicySection>
      <PolicySection title="Tracking">
        <p>
          When your order ships we will email you a tracking link. You can also check status on our <Link href="/track-order">Track order</Link> page.
        </p>
      </PolicySection>
      <PolicySection title="Delays and failed delivery">
        <p>Delivery times are estimates and can be affected by courier delays, weather or public holidays. If a delivery fails because of an incorrect address or because nobody was available, re-shipping charges may apply.</p>
      </PolicySection>
      <ContactBlock />
    </SupportPage>
  )
}
