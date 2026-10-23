import { NotFoundContent } from "@/components/site/not-found-content"
import { StoreShell } from "@/app/(store)/store-shell"

// Unknown URLs (and hidden admin routes) render outside the (store) group, so this page adds the
// storefront chrome itself.
export default function NotFound() {
  return (
    <StoreShell>
      <NotFoundContent />
    </StoreShell>
  )
}
