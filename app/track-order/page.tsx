import type { Metadata } from "next"
import { DemoForm } from "@/components/site/demo-form"
import { Note, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Track your order", description: "Track your Chaanavya order." }

export default function TrackOrderPage() {
  return (
    <SupportPage eyebrow="Order support" title="Track order." lead="Enter your order details below. Live tracking will connect as soon as the store backend is launched.">
      <Note>Frontend preview: this form validates your details but does not look up an order yet.</Note>
      <DemoForm
        submitLabel="Check order"
        successMessage="Your details look good. Live tracking will activate with the order backend."
        fields={[
          { name: "order", label: "Order number", autoComplete: "off", placeholder: "e.g. AU10482" },
          { name: "email", label: "Email used at checkout", type: "email", autoComplete: "email", placeholder: "you@example.com" },
        ]}
      />
    </SupportPage>
  )
}
