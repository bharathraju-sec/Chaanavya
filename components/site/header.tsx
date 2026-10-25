import Image from "next/image"
import Link from "next/link"
import { UserRound } from "lucide-react"
import { BagButton } from "@/components/cart/cart-sheet"
import { Button } from "@/components/ui/button"
import { DesktopNav, HeaderFrame, MobileNav, SearchDialog, type SearchEntry } from "./header-client"

export type HeaderAccount = { href: string; label: "Sign in" | "Account"; external: boolean }

// Sign in / account: icon on small screens (tight padding so the centred logo still fits at 375px), icon and label from 901px, matching Search.
function AccountButton({ account }: { account: HeaderAccount }) {
  const content = (
    <>
      <UserRound className="size-5" strokeWidth={1.5} aria-hidden />
      <span className="hidden min-[901px]:inline" aria-hidden>
        {account.label}
      </span>
    </>
  )
  const label = account.label === "Sign in" ? "Sign in or create an account" : "Your account"
  return (
    <Button asChild variant="ghost" className="h-11 gap-2 px-2 label-caps font-medium min-[901px]:px-2.5">
      {account.external ? (
        <a href={account.href} rel="noopener noreferrer" aria-label={label}>
          {content}
        </a>
      ) : (
        <Link href={account.href} aria-label={label}>
          {content}
        </Link>
      )}
    </Button>
  )
}

export function SiteHeader({ searchEntries, account }: { searchEntries: SearchEntry[]; account: HeaderAccount }) {
  return (
    <>
      <div className="bg-ink px-4 py-2.5 text-center text-[11px] leading-normal font-medium tracking-[0.14em] text-on-dark uppercase max-sm:text-[10px] max-sm:tracking-[0.1em]">
        Free shipping across India
        <span className="px-3 text-gold-on-dark max-sm:hidden" aria-hidden>
          /
        </span>
        <span className="max-sm:block">7-day returns</span>
      </div>
      <HeaderFrame>
        <div className="mx-auto grid h-16 max-w-[1440px] grid-cols-[1fr_auto_1fr] items-center px-2 min-[901px]:h-[72px] min-[901px]:px-[clamp(16px,4vw,56px)]">
          <div className="flex items-center min-[901px]:gap-1">
            <MobileNav />
            <SearchDialog products={searchEntries} />
          </div>
          <Link href="/" aria-label="Chaanavya home" className="flex items-center gap-2 font-serif text-[19px] font-semibold tracking-[0.15em] min-[901px]:gap-2.5 min-[901px]:text-[26px] min-[901px]:tracking-[0.2em] max-[360px]:text-[17px]">
            <Image src="/assets/logo-mark.png" alt="" width={38} height={38} priority className="size-7 object-contain min-[901px]:size-[38px] max-[360px]:hidden" />
            <span>CHAANAVYA</span>
          </Link>
          <div className="flex items-center justify-end min-[901px]:gap-1">
            <AccountButton account={account} />
            <BagButton />
          </div>
        </div>
        <DesktopNav />
      </HeaderFrame>
    </>
  )
}
