import Image from "next/image"
import Link from "next/link"
import { BagButton } from "@/components/cart/cart-sheet"
import { DesktopNav, MobileNav, SearchDialog, type SearchEntry } from "./header-client"

export function SiteHeader({ searchEntries }: { searchEntries: SearchEntry[] }) {
  return (
    <>
      <div className="bg-ink px-4 py-2.5 text-center text-[11px] leading-normal font-medium tracking-[0.14em] text-on-dark uppercase max-sm:text-[10px] max-sm:tracking-[0.1em]">
        Complimentary shipping over ₹2,499
        <span className="px-3 text-gold-on-dark max-sm:hidden" aria-hidden>
          /
        </span>
        <span className="max-sm:block">White-glove 10-day returns</span>
      </div>
      <header className="sticky top-0 z-40 border-b border-line bg-paper">
        <div className="mx-auto grid h-16 max-w-[1440px] grid-cols-[1fr_auto_1fr] items-center px-2 min-[901px]:h-[72px] min-[901px]:px-[clamp(16px,4vw,56px)]">
          <div className="flex items-center gap-1">
            <MobileNav />
            <SearchDialog products={searchEntries} />
          </div>
          <Link href="/" aria-label="Chaanavya home" className="flex items-center gap-2 font-serif text-[19px] font-semibold tracking-[0.15em] min-[901px]:gap-2.5 min-[901px]:text-[26px] min-[901px]:tracking-[0.2em] max-[360px]:text-[17px]">
            <Image src="/assets/logo-mark.png" alt="" width={38} height={38} priority className="size-7 object-contain min-[901px]:size-[38px] max-[360px]:hidden" />
            <span>CHAANAVYA</span>
          </Link>
          <div className="flex justify-end">
            <BagButton />
          </div>
        </div>
        <DesktopNav />
      </header>
    </>
  )
}
