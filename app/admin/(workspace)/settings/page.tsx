import { AccessDenied, PageHeader, Section } from "@/components/admin/blocks"
import { TeamManager } from "@/components/admin/team-manager"
import { checkEnv } from "@chaanavya/shared/config/env"
import { apiGet } from "@/lib/api/server"
import { requireAdminPage } from "@/lib/auth/permissions"

type Report = { environment: string; settings: { name: string; kind: string; required: boolean; status: "set" | "missing" }[]; problems: { name: string; problem: string }[] }

// Owner settings: configuration status (names only, never values) for the API and this web host,
// and the team. Since Stage 07 each service reports its own settings.
export default async function SettingsPage() {
  const { allowed, staff } = await requireAdminPage("settings.manage")
  if (!allowed) return <AccessDenied section="Settings" />
  const [api, team] = await Promise.all([
    apiGet("/api/admin/settings", "/api/v1/admin/settings"),
    staff.capabilities.has("staff.manage") ? apiGet("/api/admin/staff?limit=100", "/api/v1/admin/staff") : null,
  ])
  if (!api.ok) throw new Error(`settings lookup failed with ${api.status}`)
  if (team && !team.ok) throw new Error(`staff lookup failed with ${team.status}`)
  const members = team?.ok ? team.data.data : []
  const web = checkEnv(process.env, { service: "web" })
  const reports: [string, Report][] = [
    ["API", api.data.data],
    ["Web host", { environment: web.environment, settings: web.settings, problems: web.errors }],
  ]

  return (
    <>
      <PageHeader eyebrow="Owner" title="Settings">
        <p>Configuration lives in the hosting secret store. This page shows what is set for this deployment, never the values.</p>
      </PageHeader>

      <Section title="Team">
        <TeamManager members={members.map(({ id, email, roles, twoFactorEnabled, disabledAt, etag }) => ({ id, email, roles, twoFactorEnabled, disabledAt, etag }))} currentUserId={staff.userId} />
        <p className="mt-4 text-sm text-muted-foreground">
          New staff accounts are created by an owner with <code className="font-mono text-ink">npm run admin:add-staff</code> on a machine with database access. Email invitations arrive once an email provider is connected.
        </p>
      </Section>

      {reports.map(([service, report]) => (
        <Section key={service} title={`Configuration: ${service}`}>
          <p className="mb-4 text-sm text-muted-foreground">
            Environment: <span className="text-ink">{report.environment}</span>.
          </p>
          {report.problems.length > 0 && (
            <ul role="alert" className="mb-4 border border-destructive/40 bg-card px-4 py-3 text-sm text-destructive">
              {report.problems.map(e => (
                <li key={`${e.name}:${e.problem}`}>
                  {e.name}: {e.problem}
                </li>
              ))}
            </ul>
          )}
          <div className="overflow-x-auto border border-line bg-card">
            <table className="w-full min-w-[480px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th scope="col" className="px-4 py-3 font-semibold">Setting</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Kind</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {report.settings.map(s => (
                  <tr key={s.name} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3 font-mono text-xs text-ink">{s.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.kind}</td>
                    <td className="px-4 py-3 text-ink">{s.status === "set" ? "Set" : s.required ? "Missing (required)" : "Not set"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}
    </>
  )
}
