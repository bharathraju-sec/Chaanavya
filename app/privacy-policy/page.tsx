import type { Metadata } from "next"
import Link from "next/link"
import { PolicyList as List, PolicySection, PolicySubhead as Sub, SupportEmail as Email, SupportPage, SupportPhone as Phone } from "@/components/site/support"

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How Chaanavya collects, uses, shares, stores and protects personal information, and how to exercise your privacy rights.",
}

// Owner-supplied policy (received and dated 13 October 2026). Formatting only: broken mailto
// links in the source are rendered as working links, and "date of birth", which followed the
// end of the contact-information list, is included in that list.

export default function PrivacyPolicyPage() {
  return (
    <SupportPage
      policy
      eyebrow="Your data, respected"
      title="Privacy policy."
      lead={
        <>
          Last updated: <time dateTime="2026-10-13">13 October 2026</time>
        </>
      }
    >
      <PolicySection title="Introduction">
        <p>
          At <strong>Chaanavya</strong>, we respect your privacy and are committed to handling personal information responsibly.
        </p>
        <p>
          This Privacy Policy explains how <strong>Chaanavya</strong> (&ldquo;Chaanavya&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo; or &ldquo;our&rdquo;) collects, uses, shares, stores and otherwise processes personal information when you:
        </p>
        <List
          items={[
            <>
              visit <Link href="/">www.chaanavya.in</Link>;
            </>,
            "make a purchase;",
            "create an account;",
            "communicate with us;",
            "subscribe to marketing;",
            "participate in promotions; or",
            "otherwise interact with our online store and services.",
          ]}
        />
        <p>
          Our online store is hosted using <strong>Shopify</strong>.
        </p>
        <p>By interacting with our website and services, you acknowledge the practices described in this Privacy Policy.</p>
      </PolicySection>

      <PolicySection title="1. Information we may collect">
        <p>Depending on how you interact with Chaanavya, we may collect information such as:</p>
        <Sub>Identity information</Sub>
        <List items={["full name;", "account name; and", "other information you provide to identify yourself."]} />
        <Sub>Contact information</Sub>
        <List items={["email address;", "mobile number;", "billing address;", "shipping address;", "other contact details; and", "date of birth."]} />
        <Sub>Order information</Sub>
        <List
          items={["products ordered;", "size and colour selections;", "order value;", "order history;", "returns and exchanges;", "delivery details; and", "customer support history."]}
        />
        <Sub>Payment information</Sub>
        <p>Payments may be processed by third-party payment providers. Depending on the method used, relevant payment information may include:</p>
        <List
          items={[
            "payment method;",
            "transaction reference;",
            "payment status;",
            "limited card or account information made available to us by the payment provider; and",
            "refund information.",
          ]}
        />
        <p>Chaanavya does not necessarily receive or store complete payment-card credentials.</p>
        <Sub>Account information</Sub>
        <p>Where customer accounts are available, we may process:</p>
        <List items={["account credentials;", "account preferences;", "saved addresses;", "order history; and", "other account-related information."]} />
        <Sub>Device and usage information</Sub>
        <p>When you use our website, certain technical information may be collected automatically, including:</p>
        <List
          items={[
            "IP address;",
            "browser type;",
            "device type;",
            "operating system;",
            "website activity;",
            "pages visited;",
            "referral source;",
            "interaction information; and",
            "cookie or similar technology identifiers.",
          ]}
        />
        <Sub>Customer communications</Sub>
        <p>If you contact us, we may process information contained in:</p>
        <List items={["emails;", "WhatsApp communications;", "support requests;", "product enquiries;", "complaints;", "return requests; and", "other correspondence."]} />
        <Sub>Reviews and user content</Sub>
        <p>If you submit:</p>
        <List items={["product reviews;", "ratings;", "photographs;", "testimonials;", "comments; or", "social media content,"]} />
        <p>we may process the information you voluntarily provide.</p>
      </PolicySection>

      <PolicySection title="2. How we collect information">
        <p>We may collect personal information:</p>
        <Sub>Directly from you</Sub>
        <p>For example, when you:</p>
        <List
          items={[
            "place an order;",
            "complete checkout;",
            "create an account;",
            "subscribe to our newsletter;",
            "contact customer service;",
            "request a return;",
            "enter a promotion; or",
            "provide a review.",
          ]}
        />
        <Sub>Automatically</Sub>
        <p>Certain information may be collected through:</p>
        <List items={["cookies;", "pixels;", "analytics technologies;", "Shopify functionality; and", "similar website technologies."]} />
        <Sub>From service providers</Sub>
        <p>We may receive relevant information from organisations that assist us with:</p>
        <List items={["Shopify store operation;", "payments;", "fraud prevention;", "delivery;", "analytics;", "advertising; and", "customer communications."]} />
      </PolicySection>

      <PolicySection title="3. Why we use personal information">
        <p>We may process personal information for purposes including:</p>
        <Sub>Processing orders</Sub>
        <p>To:</p>
        <List
          items={[
            "receive and process purchases;",
            "verify payment;",
            "fulfil orders;",
            "arrange delivery;",
            "provide order confirmations; and",
            "communicate order status.",
          ]}
        />
        <Sub>Customer service</Sub>
        <p>To:</p>
        <List
          items={[
            "answer questions;",
            "provide product assistance;",
            "assist with sizing;",
            "handle complaints;",
            "process returns and exchanges;",
            "resolve delivery issues; and",
            "personalise orders.",
          ]}
        />
        <Sub>Account management</Sub>
        <p>To create and maintain customer accounts and provide account-related functionality.</p>
        <Sub>Fraud and security</Sub>
        <p>To:</p>
        <List
          items={[
            "verify transactions;",
            "identify suspicious activity;",
            "prevent fraud;",
            "protect our customers;",
            "secure our website; and",
            "enforce our policies.",
          ]}
        />
        <Sub>Marketing</Sub>
        <p>Where permitted, we may use contact information to send:</p>
        <List
          items={[
            "product launches;",
            "collection updates;",
            "promotional offers;",
            "sale announcements;",
            "newsletters; and",
            "other marketing communications.",
          ]}
        />
        <p>Where consent is required, marketing communications will be based on the consent provided.</p>
        <Sub>Website improvement</Sub>
        <p>We may analyse website usage to:</p>
        <List
          items={[
            "improve navigation;",
            "understand customer preferences;",
            "measure performance;",
            "improve our products;",
            "improve website functionality; and",
            "understand how customers discover Chaanavya.",
          ]}
        />
        <Sub>Legal and compliance purposes</Sub>
        <p>We may process information where reasonably necessary to:</p>
        <List
          items={[
            "maintain business records;",
            "comply with tax or accounting requirements;",
            "respond to lawful requests;",
            "resolve disputes;",
            "enforce agreements; and",
            "comply with applicable law.",
          ]}
        />
      </PolicySection>

      <PolicySection title="4. Legal basis and consent">
        <p>Where processing is based on your consent, we aim to ensure that consent is:</p>
        <List items={["informed;", "specific;", "freely provided;", "clear; and", "capable of being withdrawn."]} />
        <p>You may withdraw consent for consent-based processing using the method provided with the relevant communication or by contacting Chaanavya.</p>
        <p>Withdrawal of consent does not necessarily affect processing that:</p>
        <List items={["occurred lawfully before withdrawal; or", "remains necessary or permitted under applicable law."]} />
        <p>For example, withdrawing marketing consent does not prevent us from processing information necessary to complete an existing order.</p>
      </PolicySection>

      <PolicySection title="5. Information necessary to complete a purchase">
        <p>Certain information is necessary for Chaanavya to provide requested products or services. For example, we generally require:</p>
        <List
          items={[
            "your name;",
            "contact details such as phone number and email address;",
            "delivery address;",
            "order information; and",
            "payment-related information",
          ]}
        />
        <p>to process and deliver an order.</p>
        <p>If required information is not provided, we may be unable to complete the requested transaction.</p>
      </PolicySection>

      <PolicySection title="6. Shopify">
        <p>Our ecommerce store is hosted using Shopify.</p>
        <p>Shopify provides the technology that enables us to operate our online store, checkout and related ecommerce functionality.</p>
        <p>As a result, Shopify may process personal information when visitors:</p>
        <List items={["browse our website;", "make purchases;", "interact with checkout; or", "otherwise use Shopify-powered functionality."]} />
        <p>Shopify may process information in accordance with its own privacy documentation and applicable agreements with merchants.</p>
        <p>Because Shopify and its service providers operate internationally, personal information may in some circumstances be processed or stored outside the country in which the customer is located, subject to applicable legal requirements.</p>
      </PolicySection>

      <PolicySection title="7. Payment providers">
        <p>Chaanavya may use third-party payment gateways and financial service providers to process transactions.</p>
        <p>These providers may independently process information necessary to:</p>
        <List items={["authenticate payments;", "process transactions;", "prevent fraud;", "issue refunds; and", "comply with financial regulations."]} />
        <p>Customers should also review the privacy terms of the relevant payment provider where appropriate.</p>
      </PolicySection>

      <PolicySection title="8. Shipping and logistics providers">
        <p>We may share information necessary to fulfil your order with courier and logistics providers. This may include:</p>
        <List
          items={[
            "customer name;",
            "phone number;",
            "delivery address;",
            "order reference;",
            "COD amount where applicable; and",
            "other information reasonably necessary for delivery.",
          ]}
        />
        <p>Courier providers may contact customers directly regarding delivery.</p>
      </PolicySection>

      <PolicySection title="9. Service providers">
        <p>Chaanavya may use third-party providers to assist with business operations, including:</p>
        <List
          items={[
            "ecommerce hosting;",
            "payment processing;",
            "shipping;",
            "email communications;",
            "SMS or WhatsApp communication;",
            "analytics;",
            "website functionality;",
            "customer support;",
            "advertising;",
            "fraud prevention;",
            "accounting; and",
            "technology services.",
          ]}
        />
        <p>We aim to share only information reasonably necessary for the relevant service.</p>
      </PolicySection>

      <PolicySection title="10. Advertising and analytics">
        <p>We may use analytics or advertising tools to understand website activity and measure or improve our marketing.</p>
        <p>Depending on our store configuration, these tools may collect information through:</p>
        <List items={["cookies;", "pixels;", "device identifiers;", "browser information; or", "similar technologies."]} />
        <p>Where required, customers will be provided with appropriate consent or privacy controls.</p>
      </PolicySection>

      <PolicySection title="11. Cookies">
        <p>Our website may use cookies and similar technologies. Cookies may be used for purposes including:</p>
        <List
          items={[
            "remembering shopping-cart contents;",
            "enabling checkout;",
            "maintaining account sessions;",
            "preventing fraud;",
            "remembering preferences;",
            "measuring website performance;",
            "analytics; and",
            "advertising.",
          ]}
        />
        <p>Some cookies are necessary for the website to function, while others may support analytics or marketing.</p>
        <p>Where available and required, customers may manage cookie preferences through the privacy or cookie controls provided on the website.</p>
      </PolicySection>

      <PolicySection title="12. Marketing communications">
        <p>Where you have subscribed or where otherwise permitted by law, we may send marketing communications through:</p>
        <List items={["email;", "SMS;", "WhatsApp; or", "other authorised communication channels."]} />
        <p>You may opt out of marketing communications using:</p>
        <List items={["an unsubscribe link;", "available preference settings; or", "by contacting us."]} />
        <p>Opting out of promotional communications will not ordinarily stop essential transactional messages relating to:</p>
        <List items={["orders;", "payments;", "shipping;", "returns; or", "customer service."]} />
      </PolicySection>

      <PolicySection title="13. When we may share personal information">
        <p>We do not disclose personal information indiscriminately. Information may be shared where reasonably necessary with:</p>
        <List
          items={[
            "Shopify;",
            "payment providers;",
            "courier and logistics providers;",
            "technology providers;",
            "marketing or analytics providers;",
            "professional advisers;",
            "government authorities where lawfully required; and",
            "other providers necessary to operate our business.",
          ]}
        />
      </PolicySection>

      <PolicySection title="14. Business transfers">
        <p>If Chaanavya undergoes:</p>
        <List items={["restructuring;", "merger;", "acquisition;", "sale;", "transfer of assets; or", "change of ownership,"]} />
        <p>personal information may form part of the transferred business records, subject to applicable legal requirements.</p>
      </PolicySection>

      <PolicySection title="15. Legal disclosure">
        <p>We may disclose information where reasonably necessary to:</p>
        <List
          items={[
            "comply with applicable law;",
            "respond to valid legal process;",
            "protect legal rights;",
            "prevent fraud;",
            "investigate unlawful conduct; or",
            "protect the safety of customers, Chaanavya or others.",
          ]}
        />
      </PolicySection>

      <PolicySection title="16. Data retention">
        <p>We retain personal information only for as long as reasonably necessary for the purpose for which it was collected or as required by law.</p>
        <p>Retention periods may depend on factors including:</p>
        <List
          items={[
            "whether you maintain an account;",
            "whether an order remains active;",
            "accounting requirements;",
            "tax obligations;",
            "dispute resolution;",
            "fraud prevention; and",
            "applicable legal requirements.",
          ]}
        />
        <p>Information that is no longer required may be deleted, anonymised or otherwise handled in accordance with applicable requirements.</p>
      </PolicySection>

      <PolicySection title="17. Data security">
        <p>Chaanavya takes reasonable organisational and technical measures intended to protect personal information against:</p>
        <List items={["unauthorised access;", "loss;", "misuse;", "alteration;", "disclosure; and", "destruction."]} />
        <p>However, no internet transmission or electronic storage system can be guaranteed to be completely secure.</p>
        <p>Customers should also protect their own account credentials and devices.</p>
      </PolicySection>

      <PolicySection title="18. Your privacy rights">
        <p>Depending on applicable law, you may have rights concerning your personal information. These may include the ability to:</p>
        <List
          items={[
            "request information about personal data being processed;",
            "request correction of inaccurate information;",
            "request updating of incomplete information;",
            "request erasure where applicable;",
            "withdraw consent where processing is based on consent;",
            "raise a grievance; and",
            "exercise other rights provided under applicable law.",
          ]}
        />
        <p>Requests can be submitted using the contact information at the end of this policy.</p>
        <p>We may need to reasonably verify your identity before processing certain requests.</p>
      </PolicySection>

      <PolicySection title="19. Correction of personal information">
        <p>If information associated with your order or account is incorrect or outdated, please contact us.</p>
        <p>We will make reasonable efforts to correct or update eligible information.</p>
        <p>Certain records may need to be retained unchanged for legal, tax, fraud-prevention or accounting purposes.</p>
      </PolicySection>

      <PolicySection title="20. Withdrawing consent">
        <p>Where processing relies on your consent, you may request to withdraw that consent.</p>
        <p>Withdrawal should be reasonably easy to exercise and can be requested through:</p>
        <p>
          <strong>Email:</strong> <Email />
        </p>
        <p>Where the withdrawal concerns marketing, you may also use the unsubscribe mechanism contained in the relevant message.</p>
        <p>Withdrawal will apply prospectively and does not invalidate lawful processing that took place before withdrawal.</p>
      </PolicySection>

      <PolicySection title="21. Children">
        <p>Chaanavya&apos;s products and services are primarily intended for adults and customers capable of entering into transactions.</p>
        <p>We do not knowingly seek to collect personal information from children contrary to applicable law.</p>
        <p>Where parental or guardian consent is legally required, relevant processing should take place only with the appropriate consent.</p>
        <p>If you believe that a child&apos;s personal information has been provided to us improperly, please contact us.</p>
      </PolicySection>

      <PolicySection title="22. Social media">
        <p>Chaanavya may maintain accounts on third-party social media platforms.</p>
        <p>When you interact with Chaanavya through social media, the relevant platform may independently process information according to its own privacy terms.</p>
        <p>If you voluntarily tag Chaanavya or provide content to us, we may contact you regarding permission to repost or use that content where appropriate.</p>
      </PolicySection>

      <PolicySection title="23. Third-party links">
        <p>Our website may contain links to third-party websites or services.</p>
        <p>Chaanavya does not control the privacy practices of independent third parties.</p>
        <p>We recommend reviewing their privacy policies before providing personal information.</p>
      </PolicySection>

      <PolicySection title="24. International processing">
        <p>Some of our technology, ecommerce, analytics, payment or other service providers may process information outside India.</p>
        <p>Where cross-border processing occurs, we will rely on service providers and arrangements appropriate to the services being provided and applicable legal requirements.</p>
      </PolicySection>

      <PolicySection title="25. Changes to this Privacy Policy">
        <p>We may update this Privacy Policy to reflect:</p>
        <List
          items={[
            "changes in law;",
            "changes in Shopify functionality;",
            "new service providers;",
            "changes in our data practices; or",
            "changes in our business operations.",
          ]}
        />
        <p>The revised policy will be published on this page with an updated revision date.</p>
        <p>Where required, additional notice or consent may be sought for material changes.</p>
      </PolicySection>

      <PolicySection title="26. Privacy questions and grievances">
        <p>For questions, privacy requests or grievances relating to personal information, contact:</p>
        <p>
          <strong>Chaanavya</strong>
          <br />
          Bengaluru, Karnataka, India
          <br />
          Email: <Email />
          <br />
          Phone / WhatsApp: <Phone />
          <br />
          Website: <Link href="/">www.chaanavya.in</Link>
        </p>
        <p>Please include sufficient information for us to understand and respond to your request.</p>
      </PolicySection>

      <PolicySection title="27. Governing law">
        <p>This Privacy Policy is intended to operate in accordance with applicable laws of India, including applicable data-protection and consumer-protection requirements.</p>
        <p>Nothing in this policy is intended to restrict rights that cannot lawfully be excluded.</p>
      </PolicySection>
    </SupportPage>
  )
}
