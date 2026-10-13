import type { Metadata } from "next"
import { ContactBlock, FillIn, PolicySection, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Returns & refunds", description: "Chaanavya returns, refunds and cancellations." }

export default function RefundPolicyPage() {
  return (
    <SupportPage policy eyebrow="Easy returns" title="Returns & refunds." lead={<>Last updated: <FillIn>[date]</FillIn></>}>
      <PolicySection title="Returns within 10 days">
        <p>
          You can request a return within <strong>10 days of delivery</strong>. Items must be unused, unwashed and in original condition with all tags and packaging.
        </p>
      </PolicySection>
      <PolicySection title="Not eligible for return">
        <ul>
          <li>Fragrances once opened, and jewellery for hygiene reasons.</li>
          <li>Customised, altered or made-to-order pieces.</li>
          <li>Items marked final sale.</li>
        </ul>
        <p>
          <FillIn>[Edit this list to match your policy]</FillIn>
        </p>
      </PolicySection>
      <PolicySection title="How to request a return">
        <p>
          Email <FillIn>[support email]</FillIn> or call <FillIn>[phone number]</FillIn> with your order number and the item you would like to return. We will share pickup or drop-off instructions.
        </p>
      </PolicySection>
      <PolicySection title="Refunds">
        <p>
          Once we receive and check the item, we will confirm your refund. Approved refunds are issued to the original payment method within{" "}
          <strong>
            <FillIn>[5-7]</FillIn> business days
          </strong>
          ; your bank may take a few more days to show it. Original shipping charges are <FillIn>[non-refundable / refundable]</FillIn>.
        </p>
      </PolicySection>
      <PolicySection title="Damaged or wrong item">
        <p>If your order arrives damaged or incorrect, contact us within 48 hours of delivery with photos and we will replace it or refund it in full.</p>
      </PolicySection>
      <PolicySection title="Cancellations">
        <p>You can cancel an order before it has shipped for a full refund. Once shipped, please follow the return process.</p>
      </PolicySection>
      <ContactBlock />
    </SupportPage>
  )
}
