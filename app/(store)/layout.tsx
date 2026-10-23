import { StoreShell } from "@/app/(store)/store-shell"
import { NoContextMenu } from "@/components/no-context-menu"

// Storefront pages: same chrome as before the admin workspace existed. Route groups do not change URLs.
export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <StoreShell>
      <NoContextMenu />
      {children}
    </StoreShell>
  )
}
