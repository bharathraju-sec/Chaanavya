import type { Metadata } from "next"
import Link from "next/link"
import { PolicyList as List, PolicySection, SupportEmail as Email, SupportPage, SupportPhone as Phone } from "@/components/site/support"

export const metadata: Metadata = {
  title: "Shipping policy",
  description: "How Chaanavya processes, ships and delivers orders across India: processing times, delivery estimates, charges, prepaid payment, tracking and delivery issues.",
}

// Owner-supplied policy (received and dated 13 October 2026). Formatting only: day ranges
// written "1 to 3" instead of with en dashes (site copy rule), and the broken website link
// in the source rendered as a plain internal link.

const Returns = () => <Link href="/refund-policy">Return &amp; Refund Policy</Link>

export default function ShippingPolicyPage() {
  return (
    <SupportPage
      policy
      eyebrow="Delivered with care"
      title="Shipping policy."
      lead={
        <>
          Last updated: <time dateTime="2026-10-14">14 October 2026</time>
        </>
      }
    >
      <div className="mt-8 max-w-[68ch] space-y-3 leading-[1.75] text-[#2e4544]">
        <p>
          Thank you for shopping with <strong>Chaanavya</strong>.
        </p>
        <p>
          This Shipping Policy explains how orders placed through <Link href="/" className="underline underline-offset-3">www.chaanavya.in</Link> are processed, shipped and delivered.
        </p>
        <p>By placing an order with Chaanavya, you agree to the terms set out in this Shipping Policy.</p>
      </div>

      <PolicySection title="1. Shipping locations">
        <p>
          Chaanavya currently ships to eligible locations across <strong>India</strong>.
        </p>
        <p>Delivery availability depends on whether our logistics partners service the PIN code entered at checkout.</p>
        <p>We reserve the right to restrict delivery to certain locations where courier service is unavailable, unreliable or temporarily suspended.</p>
      </PolicySection>

      <PolicySection title="2. Order processing">
        <p>
          Orders are generally processed within <strong>1 to 3 business days</strong> after successful order confirmation and payment verification.
        </p>
        <p>Orders placed on:</p>
        <List items={["Sundays;", "public holidays;", "national holidays; or", "other non-working days"]} />
        <p>may begin processing on the next working day.</p>
        <p>During sales, festive periods, new collection launches or periods of unusually high order volume, processing may take longer.</p>
        <p>Customers will be informed where there is a significant delay affecting their order.</p>
      </PolicySection>

      <PolicySection title="3. Estimated delivery time">
        <p>Once dispatched, orders are generally expected to arrive within approximately:</p>
        <List
          items={[
            <>
              <strong>Metro and Tier-1 cities:</strong> 2 to 5 business days
            </>,
            <>
              <strong>Other major cities:</strong> 3 to 7 business days
            </>,
            <>
              <strong>Remote or less accessible locations:</strong> 5 to 10 business days
            </>,
          ]}
        />
        <p>These timelines are estimates and are not guaranteed delivery dates.</p>
        <p>Actual delivery times may vary depending on the destination, courier partner and circumstances outside Chaanavya&apos;s reasonable control.</p>
      </PolicySection>

      <PolicySection title="4. Shipping charges">
        <p>Shipping charges, if applicable, will be displayed during checkout before payment is completed.</p>
        <p>Chaanavya may offer:</p>
        <List
          items={["free shipping above a specified order value;", "free shipping during selected promotional periods;", "flat-rate shipping; or", "location-based shipping charges."]}
        />
        <p>Any applicable shipping charges will be communicated clearly at checkout.</p>
        <p>Shipping charges may be revised from time to time.</p>
      </PolicySection>

      <PolicySection title="5. Free shipping">
        <p>Where free shipping is offered, it may be subject to conditions such as:</p>
        <List items={["a minimum order value;", "selected PIN codes;", "promotional periods; or", "specific collections or products."]} />
        <p>The applicable terms will be displayed on the website or during checkout.</p>
      </PolicySection>

      <PolicySection title="6. Cash on Delivery">
        <p>Chaanavya does not currently offer Cash on Delivery (&ldquo;COD&rdquo;). All orders are prepaid at checkout.</p>
      </PolicySection>

      <PolicySection title="7. Order confirmation">
        <p>After successfully placing an order, customers will receive an order confirmation through one or more of the following:</p>
        <List items={["email;", "SMS;", "WhatsApp; or", "another contact method provided during checkout."]} />
        <p>Customers are responsible for ensuring that their contact details are accurate.</p>
      </PolicySection>

      <PolicySection title="8. Order tracking">
        <p>
          Once an order has been dispatched, tracking details may be shared with the customer by email, SMS, WhatsApp or through the <Link href="/track-order">order tracking section</Link> of our website.
        </p>
        <p>Tracking information may take several hours after dispatch to become active on the courier partner&apos;s system.</p>
        <p>Customers can use the provided tracking information to monitor the status of their delivery.</p>
        <p>For assistance, contact:</p>
        <p>
          <strong>Email:</strong> <Email />
          <br />
          <strong>Phone / WhatsApp:</strong> <Phone />
        </p>
      </PolicySection>

      <PolicySection title="9. Delivery address">
        <p>Customers are responsible for providing a complete and accurate delivery address when placing an order.</p>
        <p>Please ensure that the address includes:</p>
        <List
          items={[
            "recipient's full name;",
            "house/flat/building number;",
            "street or locality;",
            "city;",
            "state;",
            "PIN code;",
            "landmark where applicable; and",
            "valid mobile number.",
          ]}
        />
        <p>Chaanavya will not be responsible for delivery delays resulting from incomplete or incorrect information supplied by the customer.</p>
      </PolicySection>

      <PolicySection title="10. Address changes">
        <p>If you need to change your shipping address after placing an order, contact us as soon as possible.</p>
        <p>Address changes may be possible only before the order has been processed or dispatched.</p>
        <p>Once an order has been handed over to the courier partner, we may not be able to modify the delivery address.</p>
        <p>Where possible, Chaanavya will assist the customer in coordinating with the courier partner, but successful modification cannot be guaranteed.</p>
      </PolicySection>

      <PolicySection title="11. Delivery attempts">
        <p>Our courier partners may make multiple delivery attempts depending on their individual delivery procedures.</p>
        <p>Customers should ensure that:</p>
        <List
          items={[
            "the delivery phone number remains active;",
            "someone is available to receive the package; and",
            "courier calls or delivery messages are responded to promptly.",
          ]}
        />
        <p>Failure to respond to delivery attempts may result in the shipment being returned to Chaanavya.</p>
      </PolicySection>

      <PolicySection title="12. Failed delivery">
        <p>A delivery may fail because of:</p>
        <List
          items={[
            "incorrect address details;",
            "incorrect PIN code;",
            "unavailable recipient;",
            "repeated unanswered delivery calls;",
            "refusal to accept the order;",
            "restricted access to the delivery location; or",
            "other circumstances preventing successful delivery.",
          ]}
        />
        <p>Where an order is returned to Chaanavya because of customer-provided information or repeated failed delivery attempts, additional shipping charges may apply if the customer requests reshipment.</p>
        <p>Any such charges will be communicated before the order is shipped again.</p>
      </PolicySection>

      <PolicySection title="13. Return to Origin (RTO)">
        <p>
          If a courier is unable to successfully deliver an order, the shipment may be marked <strong>Return to Origin (&ldquo;RTO&rdquo;)</strong> and sent back to Chaanavya.
        </p>
        <p>Once an RTO shipment is received by us, customers may contact us regarding reshipment.</p>
        <p>Reshipping may be subject to an additional delivery charge where the original delivery failed due to:</p>
        <List items={["incorrect customer information;", "customer unavailability;", "refusal to accept delivery; or", "repeated unsuccessful delivery attempts."]} />
        <p>Where the failure was caused by Chaanavya or the courier partner, we will work with the customer to provide an appropriate resolution.</p>
      </PolicySection>

      <PolicySection title="14. Refused COD orders">
        <p>Not applicable: Chaanavya does not currently offer Cash on Delivery.</p>
        <p>Customers can contact Chaanavya regarding any genuine delivery or order issue.</p>
      </PolicySection>

      <PolicySection title="15. Delayed shipments">
        <p>Although we aim to deliver orders within the stated estimated timeline, delays may occasionally occur. Possible causes include:</p>
        <List
          items={[
            "heavy courier volumes;",
            "weather conditions;",
            "strikes;",
            "transportation disruption;",
            "public holidays;",
            "festivals;",
            "natural disasters;",
            "government restrictions;",
            "logistics network disruptions;",
            "remote delivery locations; or",
            "events outside our reasonable control.",
          ]}
        />
        <p>Where an order is delayed, customers are encouraged to check the tracking information first.</p>
        <p>If the shipment has not moved for an unusually long period, please contact Chaanavya and we will assist in following up with the courier partner.</p>
      </PolicySection>

      <PolicySection title="16. Lost shipments">
        <p>If a courier partner confirms that a shipment has been lost while in transit, Chaanavya will investigate the matter with the logistics provider.</p>
        <p>Where the shipment is confirmed lost before successful delivery, Chaanavya may provide an appropriate remedy, which may include:</p>
        <List items={["replacement of the order, subject to stock availability; or", "refund of the applicable amount."]} />
        <p>Customers may be required to cooperate with reasonable verification procedures during the investigation.</p>
      </PolicySection>

      <PolicySection title="17. Damaged packages">
        <p>If a package appears visibly damaged, opened, tampered with or significantly compromised at the time of delivery, customers should, where reasonably possible:</p>
        <List
          items={["photograph or record the condition of the package;", "inspect the contents promptly; and", "contact Chaanavya if there is an issue with the product."]}
        />
        <p>
          If the product itself is damaged, defective or incorrect, please refer to our <Returns />.
        </p>
      </PolicySection>

      <PolicySection title="18. Missing items">
        <p>If an order contains multiple products and one or more items are missing, customers should contact Chaanavya as soon as reasonably possible.</p>
        <p>Please provide:</p>
        <List
          items={["order number;", "photographs of the package received;", "photographs of the products received; and", "any other information reasonably requested."]}
        />
        <p>We will review the order and packing records before providing an appropriate resolution.</p>
      </PolicySection>

      <PolicySection title="19. Partial shipments">
        <p>In certain cases, products from the same order may be dispatched separately. Where this occurs, customers may receive:</p>
        <List items={["separate tracking numbers;", "multiple deliveries; or", "products on different dates."]} />
        <p>Additional shipping charges will not be imposed solely because Chaanavya chooses to split an order for fulfilment purposes.</p>
      </PolicySection>

      <PolicySection title="20. Pre-order products">
        <p>
          Products identified as <strong>Pre-Order</strong> may have longer dispatch timelines than standard products.
        </p>
        <p>Estimated dispatch or availability dates will be displayed on the relevant product page wherever possible.</p>
        <p>If an order contains both:</p>
        <List items={["ready-to-ship products; and", "pre-order products,"]} />
        <p>the entire order may be shipped together once all products become available unless otherwise stated.</p>
        <p>Customers should review product-specific delivery information before ordering a pre-order product.</p>
      </PolicySection>

      <PolicySection title="21. Made-to-order or custom products">
        <p>Where Chaanavya offers made-to-order, customised or specially produced garments, additional production time may be required before dispatch.</p>
        <p>The estimated fulfilment period will be communicated on the relevant product page or during the ordering process.</p>
        <p>These timelines are separate from courier delivery timelines.</p>
      </PolicySection>

      <PolicySection title="22. Delivery confirmation">
        <p>An order may be treated as delivered where the courier&apos;s tracking records confirm successful delivery to:</p>
        <List
          items={["the customer;", "another person present at the delivery address;", "building reception;", "security personnel; or", "another authorised recipient."]}
        />
        <p>If tracking shows an order as delivered but you have not received it, contact us promptly so that we can raise the matter with the courier partner.</p>
      </PolicySection>

      <PolicySection title="23. Incorrect delivery status">
        <p>If the courier tracking system shows your order as delivered but you have not received it, please:</p>
        <List
          ordered
          items={[
            "check with family members or other occupants;",
            "check with building reception or security;",
            "confirm the delivery address used in the order; and",
            "contact Chaanavya if the parcel cannot be located.",
          ]}
        />
        <p>We will assist in raising an investigation with the courier provider.</p>
        <p>Courier investigations may require additional time to complete.</p>
      </PolicySection>

      <PolicySection title="24. Customer responsibility">
        <p>Customers are responsible for:</p>
        <List
          items={[
            "providing accurate shipping information;",
            "providing a valid mobile number;",
            "ensuring someone is available to receive the package;",
            "responding to courier communications;",
            "checking tracking information; and",
            "promptly reporting genuine delivery issues.",
          ]}
        />
      </PolicySection>

      <PolicySection title="25. International shipping">
        <p>Chaanavya currently focuses primarily on deliveries within India.</p>
        <p>If international shipping becomes available, applicable:</p>
        <List items={["shipping charges;", "customs duties;", "import taxes;", "delivery timelines; and", "international return conditions"]} />
        <p>will be communicated separately.</p>
        <p>Unless expressly stated otherwise, any customs duties, import taxes or charges imposed by the destination country will be the responsibility of the recipient.</p>
      </PolicySection>

      <PolicySection title="26. Shipping partners">
        <p>Chaanavya may use one or more independent courier and logistics partners to deliver orders.</p>
        <p>We select shipping providers based on factors including:</p>
        <List items={["destination;", "serviceability;", "delivery speed;", "reliability; and", "operational availability."]} />
        <p>Customers may not always be able to select a specific courier provider.</p>
      </PolicySection>

      <PolicySection title="27. Force majeure">
        <p>Chaanavya will not be responsible for unreasonable delivery delays caused by circumstances beyond our reasonable control, including:</p>
        <List
          items={[
            "natural disasters;",
            "floods;",
            "fires;",
            "severe weather;",
            "strikes;",
            "epidemics;",
            "government restrictions;",
            "civil disturbances;",
            "transportation interruptions; or",
            "major logistics network failures.",
          ]}
        />
        <p>We will make reasonable efforts to communicate material delays and assist affected customers.</p>
      </PolicySection>

      <PolicySection title="28. Returns and exchanges">
        <p>
          Shipping relating to product returns or exchanges is governed by our separate <Returns />.
        </p>
        <p>Customers should review that policy for information about:</p>
        <List
          items={["return eligibility;", "exchange eligibility;", "reverse pickup;", "return shipping charges;", "damaged or defective products; and", "refunds."]}
        />
      </PolicySection>

      <PolicySection title="29. Shipping Policy changes">
        <p>Chaanavya may update this Shipping Policy from time to time to reflect changes in:</p>
        <List
          items={["courier arrangements;", "fulfilment practices;", "shipping charges;", "delivery locations;", "applicable laws; or", "operational requirements."]}
        />
        <p>The most recent version will always be available on our website.</p>
      </PolicySection>

      <PolicySection title="30. Contact us">
        <p>For shipping or delivery-related questions, please contact:</p>
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
      </PolicySection>
    </SupportPage>
  )
}
