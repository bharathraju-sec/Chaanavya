import Image from "next/image"
import Link from "next/link"
import { CookieSettingsButton } from "@/components/consent/cookie-consent"
import { Stagger, StaggerItem } from "@/components/motion/motion"
import { footerNav } from "./nav"

export function SiteFooter({ cookieSettings = false }: { cookieSettings?: boolean }) {
  return (
    <footer className="border-t border-line bg-sand">
      <Stagger className="page-wrap grid grid-cols-2 gap-x-5 gap-y-8 pt-[clamp(56px,7vw,96px)] pb-12 md:grid-cols-3 lg:grid-cols-[2fr_1fr_1fr_1fr] lg:gap-10">
        <StaggerItem className="col-span-full lg:col-span-1">
          <Link href="/" aria-label="Chaanavya home" className="inline-block">
            <Image src="/assets/logo-full.png" alt="Chaanavya, organic cotton clothing" width={150} height={155} className="h-auto w-[150px]" />
          </Link>
          {/* Template slogan, flagged for replacement. */}
          <p className="mt-6 max-w-[260px] font-serif text-2xl leading-snug italic">Draped for now. Made to reign.</p>
        </StaggerItem>
        {footerNav.map(group => (
          <StaggerItem key={group.heading}>
            <h3 className="eyebrow mb-4 font-sans">{group.heading}</h3>
            <ul>
              {group.links.map(link => (
                <li key={link.href}>
                  {/* Underline draws in from the left on hover and focus. */}
                  <Link
                    href={link.href}
                    className="relative inline-block py-[7px] text-sm after:absolute after:inset-x-0 after:bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 after:ease-editorial hover:after:scale-x-100 focus-visible:after:scale-x-100"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </StaggerItem>
        ))}
      </Stagger>
      <div className="page-wrap flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line-strong py-5 pb-[calc(20px+env(safe-area-inset-bottom))] text-xs text-muted-foreground">
        <span>© 2026 Chaanavya</span>
        {cookieSettings && <CookieSettingsButton className="min-h-11 underline-offset-4 hover:text-ink hover:underline" />}
      </div>
    </footer>
  )
}
