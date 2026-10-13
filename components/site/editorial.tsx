import Link from "next/link"
import { ArrowDown, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"

export function ArrowLink({ href, children, down, className, "aria-label": ariaLabel }: { href: string; children: React.ReactNode; down?: boolean; className?: string; "aria-label"?: string }) {
  const Icon = down ? ArrowDown : ArrowRight
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={cn(
        "group/link label-caps inline-flex min-h-11 items-center gap-2 underline decoration-1 underline-offset-[7px] transition-colors hover:text-terra",
        className
      )}
    >
      {children}
      <Icon className={cn("size-4 transition-transform duration-200 ease-editorial", down ? "group-hover/link:translate-y-0.5" : "group-hover/link:translate-x-0.5")} strokeWidth={1.5} aria-hidden />
    </Link>
  )
}

export function SectionHead({ eyebrow, title, link }: { eyebrow: string; title: React.ReactNode; link?: { href: string; label: string } }) {
  return (
    <div className="mb-[clamp(28px,4vw,48px)] flex items-end justify-between gap-6 max-sm:flex-col max-sm:items-start max-sm:gap-2">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-3 text-[clamp(36px,4.4vw,60px)]">{title}</h2>
      </div>
      {link && (
        <ArrowLink href={link.href} className="shrink-0">
          {link.label}
        </ArrowLink>
      )}
    </div>
  )
}
