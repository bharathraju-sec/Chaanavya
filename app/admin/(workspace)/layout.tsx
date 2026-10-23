import { AdminShell } from "@/components/admin/admin-shell"
import { ADMIN_SECTIONS } from "@/lib/admin/navigation"
import { requireAdminPage } from "@/lib/auth/permissions"

// Every workspace page: signed-in staff with a two-factor session only (checked again per page).
// Pages carry no titles of their own, so a 404 shown to non-staff never names an admin section.
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { staff, base, twoFactorWaived } = await requireAdminPage()
  const items = ADMIN_SECTIONS.filter(section => staff.capabilities.has(section.capability)).map(({ path, label, icon, planned }) => ({ path, label, icon, planned }))
  return (
    <AdminShell base={base} email={staff.email} roles={staff.roles} items={items} twoFactorWaived={twoFactorWaived}>
      {children}
    </AdminShell>
  )
}
