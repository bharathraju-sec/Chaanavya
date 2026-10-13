import type { Metadata } from "next"
import { ContactBlock, FillIn, PolicySection, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Privacy policy", description: "How Chaanavya collects, uses and protects your personal information." }

export default function PrivacyPolicyPage() {
  return (
    <SupportPage policy eyebrow="Your data, respected" title="Privacy policy." lead={<>Last updated: <FillIn>[date]</FillIn></>}>
      <PolicySection title="What we collect">
        <p>When you browse, place an order or contact us we may collect your name, email address, phone number, shipping and billing address, order history and basic device and browsing information (such as IP address and pages visited).</p>
      </PolicySection>
      <PolicySection title="Payments">
        <p>Checkout and payments are processed by Shopify and our payment partner Razorpay. Card, UPI and bank details are entered on their secure pages; Chaanavya does not see or store your full payment details.</p>
      </PolicySection>
      <PolicySection title="How we use it">
        <ul>
          <li>To process, ship and support your orders, returns and refunds.</li>
          <li>To send order updates and, only if you opt in, news and offers. You can unsubscribe at any time.</li>
          <li>To prevent fraud, meet legal and tax obligations, and improve our website.</li>
        </ul>
      </PolicySection>
      <PolicySection title="Sharing">
        <p>We share information only with service providers who help us run the store (Shopify, Razorpay, courier and delivery partners, website hosting) and when required by law. We do not sell your personal information.</p>
      </PolicySection>
      <PolicySection title="Cookies">
        <p>We use essential cookies and local storage to keep your bag and wishlist working, and may use analytics cookies to understand how the site is used.</p>
      </PolicySection>
      <PolicySection title="Your choices">
        <p>You can ask us to access, correct or delete your personal information by contacting us below. We keep order records for as long as needed for legal and accounting purposes.</p>
      </PolicySection>
      <ContactBlock />
    </SupportPage>
  )
}
