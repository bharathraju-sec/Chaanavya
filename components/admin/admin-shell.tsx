import Image from "next/image"
import Link from "next/link"
import { AdminMobileNav, AdminSidebarNav, type NavItem } from "@/components/admin/admin-nav"
import { SignOutButton } from "@/components/admin/sign-out-button"

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", STAFF: "Staff" }

function Brand({ base }: { base: string }) {
  return (
    <Link href={base || "/"} className="flex items-center gap-3">
      <Image src="/assets/logo-mark.png" alt="" width={32} height={32} className="size-8 object-contain" />
      <span className="flex flex-col leading-none">
        <span className="font-serif text-xl tracking-[0.06em] text-ink uppercase">Chaanavya</span>
        <span className="eyebrow mt-1">Admin</span>
      </span>
    </Link>
  )
}

// The admin workspace frame: sand sidebar with hairline separation on desktop, a top bar with a
// sheet menu on smaller screens. No storefront chrome (bag, cookie banner, popup) appears here.
export function AdminShell({ base, email, roles, items, twoFactorWaived = false, children }: { base: string; email: string; roles: string[]; items: NavItem[]; twoFactorWaived?: boolean; children: React.ReactNode }) {
  const who = (
    <div className="flex flex-col gap-3">
      <p className="text-sm break-all text-ink">{email}</p>
      <p className="text-xs text-muted-foreground">{roles.map(r => ROLE_LABEL[r] ?? r).join(", ")}</p>
      <SignOutButton loginHref={`${base}/login`} />
    </div>
  )
  return (
    <div className="flex min-h-svh flex-1 flex-col lg:flex-row">
      <a href="#admin-content" className="fixed -top-20 left-3 z-[300] bg-card px-4 py-3 text-sm focus:top-3">
        Skip to content
      </a>
      <header className="flex items-center justify-between border-b border-line bg-sand px-4 py-3 lg:hidden">
        <Brand base={base} />
        <AdminMobileNav items={items} base={base} />
      </header>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-sand lg:flex">
        <div className="border-b border-line px-5 py-6">
          <Brand base={base} />
        </div>
        <div className="flex-1">
          <AdminSidebarNav items={items} base={base} />
        </div>
        <div className="border-t border-line px-5 py-5">{who}</div>
      </aside>
      <main id="admin-content" className="min-w-0 flex-1 px-[clamp(16px,4vw,56px)] py-[clamp(32px,5vw,64px)]">
        {twoFactorWaived && (
          <p role="status" className="mx-auto mb-8 max-w-5xl border border-line-strong bg-card px-4 py-3 text-sm text-ink">
            Development only: two-factor sign-in is switched off, so a password is enough. Turn it back on before real staff accounts exist.
          </p>
        )}
        <div className="mx-auto max-w-5xl">{children}</div>
        <div className="mx-auto mt-16 max-w-5xl border-t border-line pt-6 lg:hidden">{who}</div>
      </main>
    </div>
  )
}
