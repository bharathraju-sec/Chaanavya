import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { PaymentHandoff } from "@/components/checkout/payment-handoff"
import { Enter, MaskLines } from "@/components/motion/motion"
import { checkoutReviewOpen } from "@/lib/checkout"

export const metadata: Metadata = { title: "Pay for your order", robots: { index: false, follow: false } }

// Pay page (Stage 14.06): hands a pending order to Razorpay's sandbox checkout. Development and staging
// only, like the review (lib/checkout.ts): in production this page does not exist until payments do.
// Razorpay may load here and nowhere else (proxy.ts, lib/payment-handoff.ts).
export default async function PayPage(props: PageProps<"/checkout/pay/[orderId]">) {
  if (!checkoutReviewOpen(process.env)) notFound()
  const { orderId } = await props.params
  return (
    <div className="page-wrap section-y">
      <Enter>
        <p className="eyebrow flex items-center gap-3">
          <span className="h-px w-10 bg-gold" aria-hidden />
          Checkout
        </p>
      </Enter>
      <MaskLines lines={["Pay for your order"]} className="mt-3 mb-10 text-[clamp(40px,6vw,68px)]" />
      <PaymentHandoff orderId={orderId} />
    </div>
  )
}
