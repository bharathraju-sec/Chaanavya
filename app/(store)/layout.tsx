import { StoreShell } from "@/app/(store)/store-shell"
import { StoreMotion } from "@/components/motion/motion"
import { NoContextMenu } from "@/components/no-context-menu"

// Storefront pages: same chrome as before the admin workspace existed. Route groups do not change URLs.
export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <StoreMotion>
      <StoreShell>
        <NoContextMenu />
        {children}
      </StoreShell>
    </StoreMotion>
  )
}
