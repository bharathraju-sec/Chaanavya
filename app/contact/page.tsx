import type { Metadata } from "next"
import { DemoForm } from "@/components/site/demo-form"
import { SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Contact us", description: "Contact Chaanavya client care." }

export default function ContactPage() {
  return (
    <SupportPage eyebrow="We are here to help" title="Contact." lead="Questions about drape, fabric or an order? Prepare a message here and our client-care connection will be added with the backend.">
      <div className="mt-11 grid gap-4 sm:grid-cols-2">
        {[
          { title: "Client care", lines: ["Monday to Saturday, 10am to 7pm IST", "hello@chaanavya.in"] },
          { title: "Styling appointments", lines: ["Private trunk shows and bridal styling calls, by request.", "styling@chaanavya.in"] },
        ].map(card => (
          <div key={card.title} className="border border-line bg-card p-7">
            <h2 className="mb-2.5 text-[28px]">{card.title}</h2>
            {card.lines.map(line => (
              <p key={line} className="text-[15px] leading-relaxed text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>
      <DemoForm
        submitLabel="Prepare message"
        successMessage="Thanks, your details are ready."
        fields={[
          { name: "name", label: "Name", autoComplete: "name" },
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          { name: "topic", label: "Topic", type: "select", placeholder: "Choose a topic", options: ["Product and sizing", "Order support", "Bridal & festive styling", "Returns"] },
          { name: "message", label: "Message", type: "textarea" },
        ]}
      />
    </SupportPage>
  )
}
