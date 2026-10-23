import { Lock } from "lucide-react"

// Shared admin building blocks (Stage 06). Empty states describe what is true; they never show
// sample figures, placeholder charts or invented counts.

export const fieldClass = "h-12 w-full border border-line-strong bg-paper px-3.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-ink"

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-10 border-b border-line pb-8">
      {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
      <h1 className="text-[clamp(36px,4vw,52px)] text-ink">{title}</h1>
      {children && <div className="mt-4 max-w-2xl text-muted-foreground">{children}</div>}
    </div>
  )
}

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[26px] text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-line bg-card px-6 py-10" data-empty-state>
      <p className="font-serif text-2xl text-ink">{title}</p>
      <div className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

export function AccessDenied({ section }: { section: string }) {
  return (
    <div className="border border-line bg-card px-6 py-10" data-access-denied>
      <Lock className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <h1 className="mt-4 text-[32px] text-ink">{section} is not part of your role</h1>
      <p className="mt-3 max-w-xl text-sm text-muted-foreground">Ask an owner if you need access. Nothing on this page was loaded for your account.</p>
    </div>
  )
}

export function ModulePlaceholder({ label, what, arrives }: { label: string; what: string; arrives: string }) {
  return (
    <>
      <PageHeader eyebrow="Not built yet" title={label} />
      <EmptyState title={`${label} will appear here`}>
        <p>{what}</p>
        <p className="mt-3">This section starts working {arrives}.</p>
      </EmptyState>
    </>
  )
}
