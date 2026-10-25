import { Enter, MaskLines, Rise } from "@/components/motion/motion"
import { PolicyContents } from "./policy-contents"

/** Anchor for a policy section heading, e.g. "3. Estimated delivery time" -> "3-estimated-delivery-time". */
const anchorFor = (title: string) =>
  title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

// Information and policy pages (2026 redesign, approved 25 October 2026): a sand header band whose
// title rises out of a mask, then the content. Policy pages add an "On this page" list beside the text.
export function SupportPage({ eyebrow, title, lead, children, policy }: { eyebrow: string; title: string; lead?: React.ReactNode; children?: React.ReactNode; policy?: boolean }) {
  return (
    <>
      <header className="border-b border-line bg-sand">
        <div className="page-wrap pt-[clamp(48px,7vw,104px)] pb-[clamp(40px,5vw,72px)]">
          <div className="max-w-[860px]">
            <Enter>
              <p className="eyebrow flex items-center gap-3">
                <span className="h-px w-10 bg-gold" aria-hidden />
                {eyebrow}
              </p>
            </Enter>
            <MaskLines lines={[title]} className="mt-4 mb-6 text-[clamp(52px,7vw,96px)] leading-[0.95] tracking-[-0.02em] text-balance" />
            {lead && (
              <Enter delay={0.35}>
                <p className="max-w-[640px] text-lg leading-relaxed text-muted-foreground">{lead}</p>
              </Enter>
            )}
          </div>
        </div>
      </header>
      {policy ? (
        <div className="page-wrap grid gap-[clamp(32px,5vw,80px)] pt-[clamp(24px,3vw,40px)] pb-[clamp(64px,9vw,128px)] lg:grid-cols-[220px_minmax(0,1fr)]">
          <PolicyContents className="pt-10" />
          <article data-policy className="min-w-0 max-w-[760px]">
            {children}
          </article>
        </div>
      ) : (
        <div className="mx-auto max-w-[880px] px-[clamp(16px,4vw,56px)] pt-[clamp(8px,2vw,24px)] pb-[clamp(64px,9vw,128px)]">{children}</div>
      )}
    </>
  )
}

export function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Rise as="section">
      <h2 id={anchorFor(title)} className="mt-12 mb-3 scroll-mt-[140px] text-3xl">
        {title}
      </h2>
      <div className="max-w-[68ch] space-y-3 leading-[1.75] text-[#2e4544] [&_a]:underline [&_a]:underline-offset-3 [&_li+li]:mt-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">{children}</div>
    </Rise>
  )
}

/** A contact or help card: lifts its border to ink on hover. Used by the contact and track order pages. */
export function SupportCard({ title, children, action }: { title: string; children: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="group/support flex h-full flex-col items-start border border-line bg-card p-7 transition-colors duration-300 hover:border-ink">
      <span className="mb-5 h-px w-16 origin-left scale-x-[0.625] bg-gold transition-transform duration-500 ease-editorial group-hover/support:scale-x-100" aria-hidden />
      <h2 className="mb-2.5 text-[28px]">{title}</h2>
      <div className="mb-6 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
      <div className="mt-auto w-full">{action}</div>
    </div>
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
