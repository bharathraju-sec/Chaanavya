import { cn } from "@/lib/utils"

export function SupportPage({ eyebrow, title, lead, children, policy }: { eyebrow: string; title: string; lead?: React.ReactNode; children?: React.ReactNode; policy?: boolean }) {
  return (
    <div className="pt-[clamp(48px,7vw,104px)] pb-[clamp(64px,9vw,128px)]">
      <div className={cn("mx-auto max-w-[800px] px-[clamp(16px,4vw,56px)]", policy && "policy")}>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-4 mb-6 text-[clamp(52px,7vw,96px)] leading-[0.95] tracking-[-0.02em]">{title}</h1>
        {lead && <p className="max-w-[640px] text-lg leading-relaxed text-muted-foreground">{lead}</p>}
        {children}
      </div>
    </div>
  )
}

/** Placeholder the owner still has to fill in (legal name, address, dates). */
export function FillIn({ children }: { children: React.ReactNode }) {
  return <mark className="bg-[#f6e2b8] px-1 text-ink">{children}</mark>
}

export function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mt-12 mb-3 text-3xl">{title}</h2>
      <div className="max-w-[68ch] space-y-3 leading-[1.75] text-[#2e4544] [&_a]:underline [&_a]:underline-offset-3 [&_li+li]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-5">{children}</div>
    </section>
  )
}

export function ContactBlock() {
  return (
    <PolicySection title="Contact">
      <p>
        <strong>Chaanavya</strong>
        <br />
        <FillIn>[Registered business / legal name]</FillIn>
        <br />
        <FillIn>[Full business address, City, State, PIN]</FillIn>
        <br />
        Email: <FillIn>[support email]</FillIn>
        <br />
        Phone: <FillIn>[phone number]</FillIn>
      </p>
    </PolicySection>
  )
}

export function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-7 border-l-2 border-gold bg-sand px-4 py-3.5 text-sm leading-relaxed">{children}</p>
}
