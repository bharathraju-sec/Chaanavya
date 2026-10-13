import Image from "next/image"
import Link from "next/link"
import { footerNav } from "./nav"

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-sand">
      <div className="page-wrap grid grid-cols-2 gap-x-5 gap-y-8 pt-[clamp(56px,7vw,96px)] pb-12 md:grid-cols-3 lg:grid-cols-[2fr_1fr_1fr_1fr] lg:gap-10">
        <div className="col-span-full lg:col-span-1">
          <Link href="/" aria-label="Chaanavya home" className="inline-block">
            <Image src="/assets/logo-full.png" alt="Chaanavya, organic cotton clothing" width={150} height={155} className="h-auto w-[150px]" />
          </Link>
          {/* Template slogan, flagged for replacement. */}
          <p className="mt-6 max-w-[260px] font-serif text-2xl leading-snug italic">Draped for now. Made to reign.</p>
        </div>
        {footerNav.map(group => (
          <div key={group.heading}>
            <h3 className="eyebrow mb-4 font-sans">{group.heading}</h3>
            <ul>
              {group.links.map(link => (
                <li key={link.href}>
                  <Link href={link.href} className="inline-block py-[7px] text-sm hover:underline hover:underline-offset-4">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="page-wrap border-t border-line-strong py-5 pb-[calc(20px+env(safe-area-inset-bottom))] text-xs text-muted-foreground">© 2026 Chaanavya</div>
    </footer>
  )
}
