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

export function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mt-12 mb-3 text-3xl">{title}</h2>
      <div className="max-w-[68ch] space-y-3 leading-[1.75] text-[#2e4544] [&_a]:underline [&_a]:underline-offset-3 [&_li+li]:mt-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">{children}</div>
    </section>
  )
}

/** Sub-heading inside a PolicySection (for example "Identity information"). */
export function PolicySubhead({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-3 font-sans text-[13px] font-semibold tracking-[0.12em] text-ink uppercase">{children}</h3>
}

export function PolicyList({ items, ordered }: { items: React.ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul"
  return (
    <Tag>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </Tag>
  )
}

// Owner-confirmed support contact (from the Terms and Return & Refund Policy supplied on 13 October 2026).
export const SUPPORT_EMAIL = "chaanavya@gmail.com"
const SUPPORT_PHONE = "+919916987935"
export const SUPPORT_WHATSAPP_URL = "https://wa.me/919916987935"

export const SupportEmail = () => <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
export const SupportPhone = () => <a href={`tel:${SUPPORT_PHONE}`}>+91 99169 87935</a>

export function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-7 border-l-2 border-gold bg-sand px-4 py-3.5 text-sm leading-relaxed">{children}</p>
}
