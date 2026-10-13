import type { Metadata } from "next"
import Link from "next/link"
import { PolicyList as List, PolicySection, SupportEmail as Email, SupportPage, SupportPhone as Phone } from "@/components/site/support"

export const metadata: Metadata = {
  title: "Return, exchange & refund policy",
  description: "How returns, size exchanges, refunds and cancellations work at Chaanavya: 7-day return window, eligibility, exclusions and refund timing.",
}

// Owner-supplied policy (received and dated 13 October 2026). Only formatting changed:
// the "5–7" range is written "5 to 7" per the site's no-en-dash rule, and the broken
// website link in the source text is rendered as a plain internal link.

const Size = () => <Link href="/size-guide">size chart</Link>

export default function RefundPolicyPage() {
  return (
    <SupportPage
      policy
      eyebrow="Easy returns"
      title="Return, exchange & refund policy."
      lead={
        <>
          Last updated: <time dateTime="2026-10-13">13 October 2026</time>
        </>
      }
    >
      <div className="mt-8 max-w-[68ch] space-y-3 leading-[1.75] text-[#2e4544]">
        <p>
          At <strong>Chaanavya</strong>, we want you to be happy with your purchase.
        </p>
        <p>
          This Return, Exchange &amp; Refund Policy explains the conditions under which products purchased from <Link href="/" className="underline underline-offset-3">www.chaanavya.in</Link> may be returned, exchanged or refunded.
        </p>
        <p>By purchasing from Chaanavya, you agree to the terms set out below.</p>
      </div>

      <PolicySection title="1. Return request period">
        <p>
          Customers may request a return or exchange within <strong>7 calendar days from the date of delivery</strong>, subject to the eligibility conditions in this policy.
        </p>
        <p>Requests received after the applicable return period may not be accepted unless required under applicable law.</p>
        <p>To request a return or exchange, contact:</p>
        <p>
          <strong>Email:</strong> <Email />
          <br />
          <strong>Phone / WhatsApp:</strong> <Phone />
        </p>
        <p>Please provide your:</p>
        <List items={["order number;", "name;", "product you wish to return or exchange;", "reason for the request; and", "photographs where relevant."]} />
      </PolicySection>

      <PolicySection title="2. Return eligibility">
        <p>To qualify for a discretionary return or exchange, the product must generally be:</p>
        <List
          items={[
            "unworn;",
            "unused;",
            "unwashed;",
            "undamaged;",
            "unaltered;",
            "free from stains;",
            "free from makeup;",
            "free from perfume, deodorant or other odours;",
            "free from pet hair or other signs of use;",
            "returned with all original tags attached; and",
            "returned in its original packaging where reasonably possible.",
          ]}
        />
        <p>Products that do not meet these conditions may be declined for return or exchange, subject to applicable consumer law.</p>
      </PolicySection>

      <PolicySection title="3. Size exchanges">
        <p>
          If you have ordered an incorrect size or require a different size, you may request an exchange within <strong>7 days of delivery</strong>.
        </p>
        <p>Size exchanges are subject to:</p>
        <List
          items={[
            "availability of the requested size;",
            "the returned product satisfying our return-condition requirements; and",
            "any applicable reverse-shipping or re-delivery charge disclosed to the customer.",
          ]}
        />
        <p>If the requested size is unavailable, we may offer:</p>
        <List items={["another available size;", "store credit; or", "another remedy agreed with the customer."]} />
        <p>
          We recommend reviewing the <Size /> provided on each product page before placing your order.
        </p>
      </PolicySection>

      <PolicySection title="4. Change-of-mind returns">
        <p>Eligible products may be returned for a change of mind within the applicable return period, provided the product meets all return-condition requirements.</p>
        <p>For discretionary change-of-mind returns, any applicable:</p>
        <List items={["return shipping charge;", "reverse pickup charge; or", "original shipping charge that is non-refundable"]} />
        <p>will be disclosed to the customer before the return is processed.</p>
        <p>Nothing in this section limits rights available where a product is defective, damaged, incorrect or otherwise does not conform to the order.</p>
      </PolicySection>

      <PolicySection title="5. Products that cannot generally be returned">
        <p>Unless defective, damaged, incorrectly supplied or otherwise required by law, the following products may be excluded from discretionary returns:</p>
        <List
          items={[
            <>
              products marked <strong>Final Sale</strong>;
            </>,
            "customised or personalised products;",
            "made-to-measure garments;",
            "altered products;",
            "products that have been worn or washed;",
            "products with removed or damaged tags;",
            "products returned outside the permitted return period;",
            "products damaged after delivery through misuse or improper care; and",
            "products specifically identified as non-returnable before purchase.",
          ]}
        />
        <p>Any product-specific return restriction will be clearly disclosed before purchase wherever applicable.</p>
      </PolicySection>

      <PolicySection title="6. Sale items">
        <p>Products purchased during a sale, promotion or clearance event may have different return or exchange conditions.</p>
        <p>
          Where an item is marked <strong>Final Sale</strong> or subject to an exchange-only condition, this will be communicated before purchase.
        </p>
        <p>These restrictions do not apply where applicable consumer law requires Chaanavya to provide a remedy for a defective, damaged, incorrect or materially misdescribed product.</p>
      </PolicySection>

      <PolicySection title="7. Defective products">
        <p>
          If you receive a product with a manufacturing defect, please contact us within <strong>7 days of delivery</strong>, or within any longer period required by applicable law.
        </p>
        <p>Please provide:</p>
        <List
          items={[
            "your order number;",
            "photographs clearly showing the defect;",
            "photographs of the complete product; and",
            "any other information reasonably required to verify the issue.",
          ]}
        />
        <p>Once reviewed, we may offer an appropriate remedy such as:</p>
        <List items={["replacement;", "exchange;", "repair where appropriate;", "store credit; or", "refund."]} />
        <p>The appropriate remedy will depend on the nature of the issue, stock availability and applicable law.</p>
      </PolicySection>

      <PolicySection title="8. Damaged products">
        <p>If your product arrives damaged during shipping, please notify Chaanavya as soon as reasonably possible.</p>
        <p>Where possible, please retain:</p>
        <List items={["the product;", "original packaging;", "courier packaging; and", "photographs or video showing the condition in which the parcel was received."]} />
        <p>This information may assist us in investigating the issue with our logistics partner.</p>
        <p>Where the damage is verified, we will provide an appropriate resolution.</p>
      </PolicySection>

      <PolicySection title="9. Incorrect products">
        <p>If Chaanavya sends:</p>
        <List items={["the wrong product;", "the wrong colour;", "the wrong size; or", "an item different from what was ordered,"]} />
        <p>please contact us promptly.</p>
        <p>Where we confirm that an incorrect product was supplied, Chaanavya will arrange an appropriate remedy without requiring the customer to bear reasonable return-shipping costs caused by our error.</p>
      </PolicySection>

      <PolicySection title="10. Colour and appearance variation">
        <p>We make reasonable efforts to display product colours and details accurately. However, slight variations may occur because of:</p>
        <List
          items={[
            "screen settings;",
            "lighting conditions;",
            "photography;",
            "fabric dye batches;",
            "printing techniques;",
            "natural textile variation; or",
            "handcrafted processes.",
          ]}
        />
        <p>Minor variations that are inherent to the fabric or production process will not necessarily be considered defects.</p>
        <p>Where a product materially differs from its description or advertised characteristics, customers may contact us for review.</p>
      </PolicySection>

      <PolicySection title="11. Handcrafted and artisanal products">
        <p>Certain Chaanavya garments may contain:</p>
        <List
          items={["hand embroidery;", "hand printing;", "hand-dyed fabrics;", "woven textiles;", "artisanal detailing; or", "other handmade elements."]}
        />
        <p>Minor irregularities or variations may be characteristic of handcrafted production and are not automatically considered manufacturing defects.</p>
      </PolicySection>

      <PolicySection title="12. Return request process">
        <p>To initiate a return or exchange:</p>
        <List
          ordered
          items={[
            "Contact Chaanavya within the applicable return period.",
            "Provide your order number and reason for return.",
            "Provide photographs where requested.",
            "Wait for return instructions or approval.",
            "Pack the item securely with tags attached.",
            "Hand the parcel to the approved pickup service or dispatch it as instructed.",
          ]}
        />
        <p>Products sent back without following the communicated return procedure may experience delays in processing.</p>
      </PolicySection>

      <PolicySection title="13. Reverse pickup">
        <p>Where available, Chaanavya may arrange reverse pickup through one of our courier partners.</p>
        <p>Reverse pickup availability depends on the customer&apos;s PIN code.</p>
        <p>Where reverse pickup is unavailable, the customer may be asked to ship the eligible product to our designated return address.</p>
        <p>The applicable return address will be provided after the return request has been approved.</p>
      </PolicySection>

      <PolicySection title="14. Return shipping charges">
        <p>For discretionary returns or size exchanges, the customer may be responsible for return shipping or reverse-pickup charges where those charges are disclosed before processing the return.</p>
        <p>Where a return is caused by:</p>
        <List
          items={[
            "a manufacturing defect;",
            "an incorrect item supplied by Chaanavya;",
            "transit damage attributable to the fulfilment process; or",
            "another issue for which Chaanavya is responsible,",
          ]}
        />
        <p>Chaanavya will ordinarily bear reasonable return-shipping costs.</p>
      </PolicySection>

      <PolicySection title="15. Return inspection">
        <p>All returned products are inspected after they reach Chaanavya. We may verify:</p>
        <List
          items={[
            "product condition;",
            "tags;",
            "signs of wear;",
            "washing;",
            "alteration;",
            "stains;",
            "damage; and",
            "whether the returned item matches the original order.",
          ]}
        />
        <p>A discretionary return may be declined if the item does not satisfy this policy.</p>
        <p>If a return is rejected after inspection, we will contact the customer regarding available options.</p>
      </PolicySection>

      <PolicySection title="16. Refunds">
        <p>Where a refund is approved, the refundable amount will be communicated to the customer.</p>
        <p>For prepaid orders, refunds will normally be processed back to the original payment method where reasonably possible.</p>
        <p>Depending on the payment provider or bank, additional time may be required for the refunded amount to appear in the customer&apos;s account.</p>
      </PolicySection>

      <PolicySection title="17. Refund processing time">
        <p>
          Once an approved return has been received and inspected, Chaanavya will aim to initiate the refund within approximately <strong>5 to 7 business days</strong>.
        </p>
        <p>After the refund has been initiated, banks and payment providers may require additional processing time.</p>
        <p>Chaanavya does not control banking-network settlement times.</p>
      </PolicySection>

      <PolicySection title="18. COD refunds">
        <p>For Cash on Delivery orders, a cash refund may not be possible.</p>
        <p>Approved COD refunds may instead be processed using a suitable electronic method, such as:</p>
        <List items={["bank transfer;", "UPI transfer; or", "another agreed digital payment method."]} />
        <p>Customers may be required to provide accurate refund details.</p>
        <p>Chaanavya will not be responsible for delays caused by incorrect banking or UPI details supplied by the customer.</p>
      </PolicySection>

      <PolicySection title="19. Shipping charges and refunds">
        <p>Original shipping or COD charges may not be refundable for discretionary change-of-mind returns where permitted by law.</p>
        <p>Where a return is necessary because of an error by Chaanavya, defective goods or another circumstance requiring a remedy under applicable law, appropriate shipping charges will be handled accordingly.</p>
      </PolicySection>

      <PolicySection title="20. Store credit">
        <p>Where appropriate and accepted by the customer, Chaanavya may offer store credit instead of a monetary refund.</p>
        <p>Any store credit terms, including validity where applicable, will be communicated when issued.</p>
        <p>Nothing in this section allows Chaanavya to substitute store credit where applicable law requires another form of remedy.</p>
      </PolicySection>

      <PolicySection title="21. Exchange availability">
        <p>Exchanges depend on stock availability. We cannot guarantee that a requested:</p>
        <List items={["size;", "colour;", "design; or", "replacement product"]} />
        <p>will remain available while the original product is being returned.</p>
        <p>If the requested exchange product becomes unavailable, we will contact the customer regarding alternative options.</p>
      </PolicySection>

      <PolicySection title="22. Exchange limit">
        <p>
          Chaanavya may limit discretionary exchanges of the same product to <strong>one exchange per order</strong>, unless otherwise agreed.
        </p>
        <p>This restriction does not limit remedies required by applicable consumer law.</p>
      </PolicySection>

      <PolicySection title="23. Cancellations before dispatch">
        <p>Customers may request cancellation before an order has been processed or dispatched. We will make reasonable efforts to accommodate the request.</p>
        <p>Once an order has entered packing or has been handed to the courier, cancellation may no longer be possible and the applicable return process may need to be followed.</p>
      </PolicySection>

      <PolicySection title="24. Cancellation by Chaanavya">
        <p>Chaanavya may cancel an order where reasonably necessary, including because of:</p>
        <List items={["product unavailability;", "payment failure;", "suspected fraud;", "incorrect pricing;", "fulfilment problems; or", "technical errors."]} />
        <p>If Chaanavya cancels a prepaid order after receiving payment, the applicable amount will be refunded.</p>
      </PolicySection>

      <PolicySection title="25. Return abuse">
        <p>Chaanavya reserves the right to review or restrict discretionary return privileges where there is reasonable evidence of:</p>
        <List
          items={[
            "repeated wearing and returning;",
            "deliberate product damage;",
            "fraudulent claims;",
            "substitution of products;",
            "misuse of COD;",
            "unusually excessive returns; or",
            "other abusive conduct.",
          ]}
        />
        <p>Any such restriction will not remove statutory consumer rights.</p>
      </PolicySection>

      <PolicySection title="26. Consumer rights">
        <p>Nothing in this policy is intended to remove or restrict rights available to consumers under applicable Indian law.</p>
        <p>Where a product is defective, deficient, damaged, spurious, materially different from its advertised characteristics or otherwise subject to mandatory consumer remedies, applicable law will prevail over inconsistent discretionary return restrictions.</p>
      </PolicySection>

      <PolicySection title="27. Policy changes">
        <p>Chaanavya may update this policy from time to time.</p>
        <p>The version applicable to an order will generally be the policy in effect when the relevant purchase was made, subject to changes required by law.</p>
      </PolicySection>

      <PolicySection title="28. Contact us">
        <p>For return, exchange, cancellation or refund assistance, contact:</p>
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
