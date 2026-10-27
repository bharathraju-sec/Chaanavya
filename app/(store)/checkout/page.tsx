import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { CheckoutReview } from "@/components/checkout/checkout-review"
import { Enter, MaskLines } from "@/components/motion/motion"
import { checkoutReviewOpen } from "@/lib/checkout"

export const metadata: Metadata = { title: "Review your order", robots: { index: false, follow: false } }

// Checkout review (Stage 12.11): open in development and staging only (lib/checkout.ts). In
// production this page does not exist until payments do. It places no order.
export default function CheckoutPage() {
  if (!checkoutReviewOpen(process.env)) notFound()
  return (
    <div className="page-wrap section-y">
      <Enter>
        <p className="eyebrow flex items-center gap-3">
          <span className="h-px w-10 bg-gold" aria-hidden />
          Checkout
        </p>
      </Enter>
      <MaskLines lines={["Review your order"]} className="mt-3 mb-10 text-[clamp(40px,6vw,68px)]" />
      <CheckoutReview />
    </div>
  )
}
