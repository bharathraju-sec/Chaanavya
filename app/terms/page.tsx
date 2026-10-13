import type { Metadata } from "next"
import Link from "next/link"
import { PolicyList, PolicySection, SupportEmail, SupportPage, SupportPhone } from "@/components/site/support"

export const metadata: Metadata = { title: "Terms & conditions", description: "Terms and conditions for using the Chaanavya website and buying from our online store." }

// Owner-supplied terms (received 2026-10-13, dated 12/10/2026). The brand spelling was normalised to
// "Chaanavya" and the legal name and grievance contact were filled from section 1, both at the owner's
// request. At the owner's choice the grievance contact names a role (Customer Support) rather than a person.

const Email = SupportEmail
const Phone = SupportPhone
const List = PolicyList
const Shipping = () => <Link href="/shipping-policy">Shipping Policy</Link>
const Returns = () => <Link href="/refund-policy">Return &amp; Refund Policy</Link>
const Privacy = () => <Link href="/privacy-policy">Privacy Policy</Link>

export default function TermsPage() {
  return (
    <SupportPage
      policy
      eyebrow="The fine print"
      title="Terms & conditions."
      lead={
        <>
          Last updated: <time dateTime="2026-10-12">12 October 2026</time>
        </>
      }
    >
      <div className="mt-8 max-w-[68ch] space-y-3 leading-[1.75] text-[#2e4544]">
        <p>
          Welcome to <strong>Chaanavya</strong>.
        </p>
        <p>
          These Terms and Conditions (&ldquo;Terms&rdquo;) govern your access to and use of our website, online store, products and services. Throughout these Terms, &ldquo;Chaanavya&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo; and &ldquo;our&rdquo; refer to <strong>Chaanavya</strong>, operating the Chaanavya brand.
        </p>
        <p>By accessing our website, browsing our products, creating an account, placing an order, or otherwise using our services, you agree to be bound by these Terms.</p>
        <p>Please read these Terms carefully before using our website. If you do not agree with these Terms, please do not use our website or purchase our products.</p>
      </div>

      <PolicySection title="1. Business information">
        <p>Chaanavya is an Indian women&apos;s clothing brand operated by:</p>
        <p>
          <strong>Legal business name:</strong> Chaanavya
          <br />
          <strong>Brand name:</strong> Chaanavya
          <br />
          <strong>Email:</strong> <Email />
          <br />
          <strong>Phone / WhatsApp:</strong> <Phone />
        </p>
        <p>For customer support, order-related queries or complaints, please contact us using the details above.</p>
      </PolicySection>

      <PolicySection title="2. Eligibility to use the website">
        <p>By using this website, you confirm that you are legally capable of entering into a binding contract under applicable Indian law.</p>
        <p>If you are under the age required to enter into a contract independently, you may use the website only with the involvement and consent of a parent or legal guardian.</p>
        <p>You agree to provide accurate, complete and current information when placing an order or creating an account.</p>
      </PolicySection>

      <PolicySection title="3. Products">
        <p>Chaanavya offers women&apos;s clothing, apparel and related fashion products.</p>
        <p>We make reasonable efforts to display product descriptions, colours, materials, measurements, photographs and other product information as accurately as possible. However, slight variations may occur due to:</p>
        <List
          items={[
            "differences in screen displays and device settings;",
            "lighting used during product photography;",
            "natural variations in fabrics, prints, dyes, embroidery or handcrafted processes;",
            "minor differences between manufacturing batches; and",
            "garment finishing and production processes.",
          ]}
        />
        <p>Such reasonable variations do not necessarily constitute a defect.</p>
        <p>Where a garment contains handcrafted, hand-dyed, hand-printed, embroidered or artisanal elements, slight irregularities may form part of the nature and character of the product.</p>
      </PolicySection>

      <PolicySection title="4. Sizing and fit">
        <p>
          Customers are responsible for reviewing the <Link href="/size-guide">size chart</Link> and product measurements provided on the relevant product page before placing an order.
        </p>
        <p>Sizing may vary between different products, silhouettes and styles.</p>
        <p>Where available, we may provide garment measurements, model measurements or fit recommendations to assist customers. These recommendations are provided as guidance only and do not guarantee that a particular size will fit every individual in the same manner.</p>
        <p>If you require assistance selecting a size, please contact us before placing your order.</p>
      </PolicySection>

      <PolicySection title="5. Product availability">
        <p>All products are subject to availability.</p>
        <p>Adding an item to your shopping cart does not reserve that item. A product may become unavailable before your order is successfully completed.</p>
        <p>We reserve the right to:</p>
        <List
          items={[
            "discontinue products;",
            "limit quantities;",
            "modify collections;",
            "change product specifications where reasonably necessary; or",
            "cancel an order where an item is unavailable.",
          ]}
        />
        <p>
          If we are unable to fulfil a prepaid order because the product is unavailable, the amount paid for the unavailable product will be refunded through the applicable payment method in accordance with our <Returns /> and applicable law.
        </p>
      </PolicySection>

      <PolicySection title="6. Pricing">
        <p>
          All prices displayed on our website are in <strong>Indian Rupees (INR)</strong> unless otherwise stated.
        </p>
        <p>Prices displayed at checkout will indicate applicable taxes and charges as required.</p>
        <p>We reserve the right to modify product prices from time to time.</p>
        <p>A price change will not ordinarily affect an order that has already been accepted and confirmed, except where permitted or required by law, including cases involving an obvious pricing or technical error.</p>
        <p>Discount codes, promotional offers and sale prices may be subject to additional conditions displayed at the time of the promotion.</p>
      </PolicySection>

      <PolicySection title="7. Orders">
        <p>Placing an order through our website constitutes an offer by you to purchase the selected products.</p>
        <p>After your order is submitted, you may receive an order confirmation by email, SMS, WhatsApp or another electronic method.</p>
        <p>We reserve the right to decline or cancel an order where reasonably necessary, including where:</p>
        <List
          items={[
            "the product is unavailable;",
            "payment has not been successfully authorised;",
            "incorrect information has been provided;",
            "fraudulent or suspicious activity is detected;",
            "there is an obvious pricing or listing error;",
            "the order violates these Terms; or",
            "fulfilment is not reasonably possible.",
          ]}
        />
        <p>
          Where we cancel a prepaid order after payment has been received, the applicable amount will be refunded in accordance with our <Returns /> and applicable law.
        </p>
      </PolicySection>

      <PolicySection title="8. Payments">
        <p>We accept the payment methods displayed at checkout, which may include:</p>
        <List
          items={["UPI;", "credit cards;", "debit cards;", "net banking;", "digital wallets;", "supported payment services; and", "Cash on Delivery, where available."]}
        />
        <p>Payment transactions may be processed through authorised third-party payment service providers.</p>
        <p>Chaanavya does not directly control the banking systems, card networks or third-party payment gateways used to process transactions.</p>
        <p>Customers must ensure that they are authorised to use the payment method selected.</p>
      </PolicySection>

      <PolicySection title="9. Cash on Delivery">
        <p>Cash on Delivery (&ldquo;COD&rdquo;) may be available for eligible locations and orders.</p>
        <p>We reserve the right to:</p>
        <List
          items={[
            "restrict COD for certain PIN codes;",
            "restrict COD for high-value orders;",
            "request order confirmation before dispatch;",
            "disable COD for customers with repeated refused or undelivered orders; or",
            "introduce a reasonable COD handling charge where clearly disclosed before checkout.",
          ]}
        />
        <p>Any applicable COD terms or charges will be displayed before the customer completes the order.</p>
      </PolicySection>

      <PolicySection title="10. Shipping and delivery">
        <p>
          Orders are shipped according to our separate <Shipping />.
        </p>
        <p>Estimated dispatch and delivery timelines displayed on the website are estimates and may vary due to circumstances including:</p>
        <List
          items={[
            "courier delays;",
            "weather conditions;",
            "public holidays;",
            "logistical disruptions;",
            "incorrect or incomplete addresses;",
            "remote delivery locations;",
            "high-volume sales periods; or",
            "events outside our reasonable control.",
          ]}
        />
        <p>Customers are responsible for providing complete and accurate delivery information.</p>
        <p>Chaanavya will make reasonable efforts to assist where a shipment is delayed or encounters a delivery issue.</p>
        <p>
          Please refer to our <Shipping /> for detailed fulfilment timelines, delivery charges and shipping conditions.
        </p>
      </PolicySection>

      <PolicySection title="11. Order tracking">
        <p>Where tracking is available, customers may receive tracking information after their order has been dispatched.</p>
        <p>Tracking information is provided by the relevant courier or logistics provider and may not update immediately after dispatch.</p>
        <p>For assistance with an order that appears significantly delayed, please contact our customer support team.</p>
      </PolicySection>

      <PolicySection title="12. Cancellations">
        <p>Customers may request cancellation of an order before it has been processed or dispatched.</p>
        <p>Once an order has entered processing, packing or shipping, cancellation may not always be possible.</p>
        <p>
          If cancellation is available, any refund will be processed in accordance with our <Returns />.
        </p>
        <p>Chaanavya reserves the right to cancel an order where required for fraud prevention, payment issues, inventory issues, fulfilment problems or other legitimate operational reasons.</p>
      </PolicySection>

      <PolicySection title="13. Returns, exchanges and refunds">
        <p>
          Returns, exchanges and refunds are governed by our separate <Returns />, which forms part of these Terms. Customers should review that policy before completing their purchase.
        </p>
        <p>The Return &amp; Refund Policy explains, among other matters:</p>
        <List
          items={[
            "the eligible return period;",
            "eligibility requirements;",
            "excluded products;",
            "exchange procedures;",
            "refund procedures;",
            "defective or incorrect products;",
            "return shipping responsibility; and",
            "expected processing timelines.",
          ]}
        />
        <p>Nothing in these Terms is intended to restrict rights available to consumers under applicable Indian law.</p>
      </PolicySection>

      <PolicySection title="14. Return condition">
        <p>Where a return is permitted under our Return &amp; Refund Policy, products must generally be returned:</p>
        <List
          items={[
            "unworn;",
            "unused;",
            "unwashed;",
            "undamaged;",
            "free from stains, perfume, makeup or other marks;",
            "with original tags attached; and",
            "in original packaging where reasonably possible.",
          ]}
        />
        <p>Products that have been worn, washed, altered, damaged after delivery or otherwise used may not qualify for a discretionary return or exchange, subject to applicable consumer law.</p>
      </PolicySection>

      <PolicySection title="15. Defective, damaged or incorrect products">
        <p>Customers should inspect their order after delivery.</p>
        <p>
          If you receive an incorrect, damaged or defective product, please contact us within the period specified in our <Returns /> and provide:
        </p>
        <List items={["your order number;", "photographs or videos showing the issue; and", "any additional information reasonably required to investigate the matter."]} />
        <p>Where an item is confirmed to have been supplied incorrectly, damaged or defective, Chaanavya will provide an appropriate remedy in accordance with applicable law and our Return &amp; Refund Policy.</p>
      </PolicySection>

      <PolicySection title="16. Sale and promotional products">
        <p>Products purchased during a sale or promotional event may be subject to specific return or exchange conditions where permitted by law.</p>
        <p>Any special conditions applicable to a sale will be clearly communicated on the relevant product page, promotion or Return &amp; Refund Policy.</p>
        <p>These conditions do not override consumer rights that cannot legally be excluded.</p>
      </PolicySection>

      <PolicySection title="17. Promotional codes and offers">
        <p>Promotional codes are subject to the conditions communicated with each offer. Unless otherwise stated:</p>
        <List
          items={[
            "promotional codes cannot be exchanged for cash;",
            "only one promotional code may be used per order;",
            "codes may have an expiry date;",
            "certain products may be excluded;",
            "minimum order values may apply; and",
            "promotional codes may not be combined with other offers.",
          ]}
        />
        <p>We reserve the right to cancel or refuse the use of a promotional code where we reasonably believe it has been misused, fraudulently obtained or applied contrary to its stated conditions.</p>
      </PolicySection>

      <PolicySection title="18. Gift cards and store credit">
        <p>Where Chaanavya offers gift cards or store credit, additional conditions may apply.</p>
        <p>Any validity period, usage restriction or other important condition will be communicated when the gift card or credit is issued, subject to applicable law.</p>
        <p>Gift cards and store credits cannot ordinarily be exchanged for cash except where required by law.</p>
      </PolicySection>

      <PolicySection title="19. Accounts">
        <p>Customers may be permitted to create an account on our website. You are responsible for:</p>
        <List items={["maintaining the confidentiality of your login credentials;", "providing accurate account information; and", "activity conducted through your account."]} />
        <p>Please notify Chaanavya promptly if you believe your account has been accessed without authorisation.</p>
        <p>We reserve the right to suspend or close accounts being used fraudulently, unlawfully or in violation of these Terms.</p>
      </PolicySection>

      <PolicySection title="20. Website use">
        <p>You agree not to use the Chaanavya website:</p>
        <List
          items={[
            "for unlawful purposes;",
            "to violate applicable laws or regulations;",
            "to impersonate another person;",
            "to provide false or fraudulent information;",
            "to attempt unauthorised access to the website or related systems;",
            "to transmit malicious software, viruses or harmful code;",
            "to scrape, copy or automatically extract website content without permission;",
            "to interfere with website security or functionality;",
            "to commit payment fraud; or",
            "to infringe the intellectual property rights of Chaanavya or any third party.",
          ]}
        />
        <p>We reserve the right to restrict access to the website where these Terms are violated.</p>
      </PolicySection>

      <PolicySection title="21. Intellectual property">
        <p>Unless otherwise stated, all content appearing on the Chaanavya website is owned by or licensed to Chaanavya. This includes, without limitation:</p>
        <List
          items={[
            "the Chaanavya name;",
            "logos;",
            "trademarks;",
            "clothing designs to the extent legally protected;",
            "photographs;",
            "videos;",
            "graphics;",
            "website designs;",
            "artwork;",
            "illustrations;",
            "written content;",
            "product descriptions; and",
            "marketing materials.",
          ]}
        />
        <p>You may access this content for personal and non-commercial use.</p>
        <p>You may not reproduce, copy, distribute, commercially exploit, modify, republish or use our intellectual property without prior written permission.</p>
      </PolicySection>

      <PolicySection title="22. User content, reviews and social media">
        <p>If you submit a product review, photograph, testimonial, comment, social media tag or other content to Chaanavya, you confirm that:</p>
        <List
          items={[
            "the content is yours or you have permission to provide it;",
            "the content does not infringe another person's rights; and",
            "the content is not unlawful, defamatory, fraudulent or misleading.",
          ]}
        />
        <p>Where you expressly provide or submit content for promotional use, you may grant Chaanavya permission to display or repost that content for reasonable marketing purposes, subject to applicable privacy and intellectual property laws.</p>
        <p>Where appropriate, we may request additional permission before using customer photographs or identifiable personal content in advertising.</p>
      </PolicySection>

      <PolicySection title="23. Third-party services">
        <p>Our website may integrate services provided by third parties, including:</p>
        <List
          items={["Shopify;", "payment gateways;", "logistics providers;", "analytics providers;", "social media platforms;", "marketing platforms; and", "other technology providers."]}
        />
        <p>Your interaction with some third-party services may also be governed by their respective terms and privacy policies.</p>
        <p>Chaanavya is not responsible for independent third-party websites or services outside our reasonable control.</p>
      </PolicySection>

      <PolicySection title="24. Shopify">
        <p>Our online store is hosted using Shopify&apos;s ecommerce platform. Shopify provides technology that enables us to offer our products and services online.</p>
        <p>
          Your information may therefore be processed by Shopify and other service providers used to operate our store, as explained further in our <Privacy />.
        </p>
      </PolicySection>

      <PolicySection title="25. Privacy">
        <p>Your privacy is important to us.</p>
        <p>
          Our collection, use, storage and processing of personal information is governed by our separate <Privacy />.
        </p>
        <p>By using our website, you acknowledge that your information may be processed as described in that policy and as permitted by applicable law.</p>
        <p>Please review our Privacy Policy before providing personal information.</p>
      </PolicySection>

      <PolicySection title="26. Marketing communications">
        <p>Where permitted, customers may choose to receive promotional communications from Chaanavya through email, SMS, WhatsApp or other channels.</p>
        <p>Where consent is required, promotional messages will be sent in accordance with the consent provided.</p>
        <p>Customers may unsubscribe from marketing communications through the unsubscribe mechanism provided or by contacting us.</p>
        <p>Transactional communications relating to orders, payments, deliveries, returns or customer service may still be sent where necessary.</p>
      </PolicySection>

      <PolicySection title="27. Accuracy of website information">
        <p>We make reasonable efforts to ensure that information on the website is accurate and current. However, typographical errors, technical errors or omissions may occasionally occur.</p>
        <p>Where an obvious error affects an order, we will contact the customer where appropriate and provide a reasonable resolution in accordance with applicable law.</p>
      </PolicySection>

      <PolicySection title="28. Website availability">
        <p>We do not guarantee that the website will always operate without interruption. Access may occasionally be restricted due to:</p>
        <List items={["maintenance;", "upgrades;", "technical problems;", "security issues;", "hosting interruptions; or", "circumstances beyond our reasonable control."]} />
        <p>We may modify or update features of the website where reasonably required.</p>
      </PolicySection>

      <PolicySection title="29. Limitation of liability">
        <p>To the maximum extent permitted by applicable law, Chaanavya will not be liable for indirect, incidental or consequential losses arising solely from the use or inability to use the website where such losses could not reasonably have been anticipated.</p>
        <p>Nothing in these Terms excludes or limits liability where such liability cannot lawfully be excluded or limited.</p>
        <p>Nothing in these Terms limits any statutory rights or remedies available to consumers under applicable Indian law.</p>
      </PolicySection>

      <PolicySection title="30. Indemnification">
        <p>To the extent permitted by applicable law, you agree to indemnify Chaanavya against losses, claims or expenses arising directly from your unlawful use of the website, fraud, infringement of another person&apos;s rights or material breach of these Terms.</p>
        <p>This provision does not apply where the loss or claim results from Chaanavya&apos;s own unlawful conduct or breach of applicable legal obligations.</p>
      </PolicySection>

      <PolicySection title="31. Force majeure">
        <p>Chaanavya will not be responsible for delays or failure to perform obligations caused by events reasonably beyond our control, including natural disasters, floods, fires, epidemics, government restrictions, transportation interruptions, strikes, internet or telecommunications failures and major logistics disruptions.</p>
        <p>Where such circumstances affect an order, we will make reasonable efforts to communicate with affected customers and fulfil or resolve orders appropriately.</p>
      </PolicySection>

      <PolicySection title="32. Fraud prevention">
        <p>We reserve the right to undertake reasonable verification measures before accepting or dispatching an order. An order may be delayed or cancelled where there are reasonable grounds to suspect:</p>
        <List
          items={[
            "unauthorised payment;",
            "identity misuse;",
            "fraudulent activity;",
            "repeated abusive returns;",
            "reselling activity contrary to stated purchase restrictions; or",
            "other unlawful activity.",
          ]}
        />
        <p>Customers may be contacted to verify information where reasonably necessary.</p>
      </PolicySection>

      <PolicySection title="33. Grievances and customer complaints">
        <p>If you have a complaint concerning a product, order, payment, return, refund, delivery or use of our website, please contact our customer support team.</p>
        <p>
          <strong>Customer support / grievance contact</strong>
          <br />
          Name: Customer Support, Chaanavya
          <br />
          Email: <Email />
          <br />
          Phone: <Phone />
          <br />
          Address: Bengaluru, Karnataka, India
        </p>
        <p>We will endeavour to acknowledge and resolve customer complaints in accordance with applicable Indian consumer protection requirements.</p>
      </PolicySection>

      <PolicySection title="34. Governing law">
        <p>These Terms are governed by the laws of India.</p>
        <p>
          Subject to applicable consumer protection laws and any statutory forum available to consumers, disputes relating to these Terms or transactions with Chaanavya shall be subject to the jurisdiction of the competent courts and authorities in <strong>Bengaluru, Karnataka, India</strong>.
        </p>
        <p>Nothing in this clause limits any right a consumer may have to approach an appropriate consumer commission, regulatory authority or other forum available under applicable law.</p>
      </PolicySection>

      <PolicySection title="35. Changes to these Terms">
        <p>We may update these Terms from time to time to reflect:</p>
        <List items={["changes to our business;", "changes to our products or services;", "changes in technology;", "changes in legal requirements; or", "operational changes."]} />
        <p>The latest version will be published on this page together with an updated &ldquo;Last updated&rdquo; date.</p>
        <p>Changes will apply prospectively except where otherwise required by law.</p>
      </PolicySection>

      <PolicySection title="36. Severability">
        <p>If any provision of these Terms is found to be invalid, unlawful or unenforceable, the remaining provisions will continue to apply to the extent permitted by law.</p>
      </PolicySection>

      <PolicySection title="37. No waiver">
        <p>If Chaanavya does not immediately enforce a provision of these Terms, this does not constitute a waiver of our right to enforce that provision later.</p>
      </PolicySection>

      <PolicySection title="38. Entire agreement">
        <p>These Terms, together with our:</p>
        <List
          items={[
            <>
              <Privacy />;
            </>,
            <>
              <Shipping />;
            </>,
            <>
              <Returns />; and
            </>,
            "any other policies or conditions expressly referenced on the website,",
          ]}
        />
        <p>constitute the terms governing use of our online store and purchases made through Chaanavya.</p>
      </PolicySection>

      <PolicySection title="39. Contact us">
        <p>For questions regarding these Terms or your order, please contact:</p>
        <p>
          <strong>Chaanavya</strong>
          <br />
          Bengaluru, Karnataka, India
          <br />
          Email: <Email />
          <br />
          Website: <Link href="/">www.chaanavya.in</Link>
        </p>
      </PolicySection>
    </SupportPage>
  )
}
