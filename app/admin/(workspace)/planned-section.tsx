import { AccessDenied, ModulePlaceholder } from "@/components/admin/blocks"
import { sectionFor } from "@/lib/admin/navigation"
import { requireAdminPage } from "@/lib/auth/permissions"

// Shared body for sections whose module is not built yet: checks the section's capability on the
// server, then says plainly that nothing is here yet. No sample rows, charts or counts.
export async function PlannedSection({ path }: { path: string }) {
  const section = sectionFor(path)
  if (!section?.planned) throw new Error(`no planned section at ${path}`)
  const { allowed } = await requireAdminPage(section.capability)
  if (!allowed) return <AccessDenied section={section.label} />
  return <ModulePlaceholder label={section.label} what={section.planned.what} arrives={section.planned.arrives} />
}
